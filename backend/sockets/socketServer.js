const { Server } = require("socket.io");
const mongoose = require("mongoose");
const Salon = require("../models/salon");
const Compte = require("../models/compte");
const Transaction = require("../models/transaction");
const { lireToken } = require("../fonctionsCommunes");
const { roleDansSalon, vuePourRole } = require("../jeux/vueTable");
const { attribuerMains } = require("../jeux/mainsDetectees");
const { initialiserChat } = require("./chat");

let io = null; // gardé pour notifierSalonFerme (appelé depuis la route DELETE /deleteSalon)
const departs = new Map(); // "salonId:compteId" -> minuterie d'un joueur déconnecté sans prévenir
const debutsManche = new Map(); // salonId -> { minuterie, debut } : délai des mises avant la manche

function avecDebutManche(salonId, salon) {
    return { ...salon, debut_manche: debutsManche.get(salonId)?.debut ?? null };
}

/** Entrées : room du salon et salon (objet); sortie : aucune. Chaque connexion de la room reçoit la vue de son rôle. */
async function diffuserTable(salonId, salon) {
	const connexions = await io.in(salonId).fetchSockets();

	const joueursEnLigne = new Set(
		connexions
			.filter((c) => c.data.role === "joueur" && c.data.user)
			.map((c) => String(c.data.user.nom)),
	);

	for (const connexion of connexions) {
		connexion.emit("game:update", {
			joueursEnLigne: [...joueursEnLigne],
			salon: vuePourRole(avecDebutManche(salonId, salon), connexion.data.role),
			message: `Mise à jour de la table pour le salon ${salonId}`,
		});
	}
}

/** Entrées : salon et compte; retire le joueur (sa main est perdue), sauvegarde et prévient la table. */
async function retirerJoueur(salonId, compteId) {
	const salon = await Salon.findById(salonId);
	if (!salon) return;
	const restants = salon.players.filter(
		(player) => String(player.id_compte) !== String(compteId),
	);
	if (restants.length === salon.players.length) return; // déjà parti
	salon.players = restants;
	salon.updated_at = new Date();
	await salon.save();
	notifierLobby(); // une place se libère
	await diffuserTable(String(salon._id), salon.toObject());
}

function annulerDepart(salonId, compteId) {
	const cle = `${salonId}:${compteId}`;
	clearTimeout(departs.get(cle));
	departs.delete(cle);
}

/** Entrées : salon et délai (ms); lance la minuterie qui démarre la manche. */
function planifierDebut(salonId, delai) {
        const minuterie = setTimeout(() => {
                debutsManche.delete(salonId);
                demarrerManche(salonId).catch((err) => console.error(err));
        }, delai);
        debutsManche.set(salonId, { minuterie, debut: Date.now() + delai });
}

/** Entrée : salon; fin du délai des mises : la manche commence s'il reste au moins une mise, et la table est prévenue. */
async function demarrerManche(salonId) {
        const demarre = await Salon.findOneAndUpdate(
                { _id: salonId, status: "waiting", "players.bet": { $gt: 0 } },
                { $set: { status: "playing", updated_at: new Date() } },
                { returnDocument: "after" },
        );
        if (demarre) notifierLobby(); // le salon passe « En cours »
        // Plus aucune mise (joueurs partis) : rien ne démarre, mais la table doit voir le compte à rebours disparaître
        const salon = demarre ?? (await Salon.findById(salonId));
        if (salon) await diffuserTable(salonId, salon.toObject());
}

/** Aucune entrée; signale au lobby que la liste des salons a changé (il relance GET /salons). Sans io (tests HTTP) : rien. */
function notifierLobby() {
	if (!io) return;
	io.to("lobby").emit("salons:changed");
}

/** Entrée : id du salon supprimé; prévient la table ("salon:closed") et vide sa room. */
function notifierSalonFerme(salonId) {
	if (!io) return;
	const room = String(salonId);
	io.to(room).emit("salon:closed", { salonId: room });
	io.in(room).socketsLeave(room);
	notifierLobby(); // le salon disparaît de la liste
	for (const [cle, minuterie] of departs) {
		if (cle.startsWith(`${room}:`)) {
			clearTimeout(minuterie);
			departs.delete(cle);
		}
	}
	clearTimeout(debutsManche.get(room)?.minuterie);
	debutsManche.delete(room);
}

/**
 * Entrées : serveur HTTP et options (delaiRetourMs : temps laissé à un joueur déconnecté pour revenir);
 * sortie : l'instance Socket.IO.
 */
function initialiserSocketServer(httpServer, { delaiRetourMs = 30_000, delaiMisesMs = 10_000 } = {}) {	
	io = new Server(httpServer, {
		cors: { origin: "http://localhost:5173", methods: ["GET", "POST"] },
		maxHttpBufferSize: 2e6, // images JPEG de la caméra
	});

	io.on("connection", (socket) => {
		// Service Python de détection. La clé doit exister : sinon undefined === undefined laisserait passer tout le monde
		const cle = process.env.CLE_DETECTION;
		if (cle && socket.handshake.auth?.cle === cle) {
			socket.join("detection");
			// mains = { croupier: main ou null, joueurs: [main, ...] } (voir separer_zones dans service.py)
			socket.on("cartes", async ({ salonId, mains } = {}) => {
				try {
					if (!mongoose.isValidObjectId(salonId))
						return console.error(
							`Salon invalide pour cartes (service de détection) : ${salonId}`,
						);

					// typeof null === "object" : ce test accepte aussi croupier = null (aucune carte en haut)
					if (typeof mains?.croupier !== "object" || !Array.isArray(mains?.joueurs))
						return console.error(
							`Mains mal formées pour cartes (service de détection) : ${JSON.stringify(mains)}`,
						);

					const salon = await Salon.findById(salonId);
					if (!salon)
						return console.error(
							`Salon introuvable pour cartes (service de détection) : ${salonId}`,
						);

					// Les cartes de la caméra deviennent l'état du salon, puis chaque navigateur reçoit game:update
					attribuerMains(salon, mains);
					salon.updated_at = new Date();
					await salon.save();
					await diffuserTable(String(salon._id), salon.toObject());
				} catch (err) {
					console.error(err);
					console.error("Erreur du serveur : cartes (service de détection).");
				}
			});
			return; // pas besoin des handlers des navigateurs
		}

		initialiserChat(io, socket);

		// Navigateur : connecté (token valide) ou invité (pas de token → user = null)
		socket.data.user = lireToken(socket.handshake.auth?.token);

		// Le rôle (dealer, joueur, spectateur) est calculé ici à partir du token, jamais envoyé par le client
		socket.on("join", async (salonId, ack) => {
			const repondre = typeof ack === "function" ? ack : () => { }; // Blackjack.jsx n'attend pas de réponse
			try {
				if (!mongoose.isValidObjectId(salonId))
					return repondre({ error: "Salon invalide." });
				const salon = await Salon.findById(salonId);
				if (!salon) return repondre({ error: "Salon introuvable." });

				// Une connexion suit un seul salon : on quitte seulement l'ancien (les rooms "chat:..." ne sont pas touchées)
				if (socket.data.salonId) socket.leave(socket.data.salonId);
				const room = String(salon._id);
				const role = roleDansSalon(salon, socket.data.user);
				socket.join(room);
				socket.data.salonId = room;
				socket.data.role = role;
				// Un joueur déconnecté qui revient à temps garde sa place
				if (socket.data.user) annulerDepart(room, socket.data.user.id);
				repondre({ salon: vuePourRole(avecDebutManche(room, salon.toObject()), role), role });	
				await diffuserTable(room, salon.toObject());
			} catch (err) {
				console.error(err);
				repondre({ error: "Erreur du serveur : join." });
			}
		});

		// Action de jeu (joueur ou dealer seulement). Le salon est celui du "join" : le client ne peut pas en viser un autre.
		socket.on("game:action", async ({ salonMaj } = {}) => {
			const { salonId, role } = socket.data;
			if (!salonId || (role !== "joueur" && role !== "dealer")) return;
			if (!salonMaj || typeof salonMaj !== "object") return;
			await diffuserTable(salonId, salonMaj);
		});


		socket.on("game:miser", async ({ mise } = {}, ack) => {
				const repondre = typeof ack === "function" ? ack : () => {};
				const { salonId, role, user } = socket.data;
				if (!salonId || role !== "joueur")
						return repondre({ error: "Seul un joueur du salon peut miser." });
				if (typeof mise !== "number" || !Number.isFinite(mise) || mise <= 0)
						return repondre({ error: "Mise invalide." });
				const montant = Math.round(mise * 100) / 100; // au cent près

				try {
						// 1. Réserver la mise : ne passe que si la manche n'est pas commencée et que le joueur n'a pas déjà misé
						const reserve = await Salon.updateOne(
								{
										_id: salonId,
										status: { $ne: "playing" },
										players: { $elemMatch: { id_compte: user.id, bet: 0 } },
								},
								{ $set: { "players.$.bet": montant, updated_at: new Date() } },
						);
						if (reserve.modifiedCount === 0)
								return repondre({ error: "Mise impossible (manche en cours ou déjà misé)." });

						// 2. Débiter le compte seulement si le solde suffit (une seule opération Mongo : pas de double débit)
						const compte = await Compte.findOneAndUpdate(
								{ _id: user.id, montant: { $gte: montant } },
								{ $inc: { montant: -montant } },
								{ new: true },
						);
						if (!compte) {
								// 3. Solde insuffisant : on annule la réservation
								await Salon.updateOne(
										{ _id: salonId, "players.id_compte": user.id },
										{ $set: { "players.$.bet": 0 } },
								);
								return repondre({ error: "Solde insuffisant." });
						}
						await Transaction.create({ id_compte: user.id, desc: "Mise blackjack en salon", montant: -montant });
						// Première mise de la manche : has puis set sans await entre les deux, donc une seule minuterie même si deux joueurs misent en même temps
						if (!debutsManche.has(salonId)) planifierDebut(salonId, delaiMisesMs);
						
						const salon = await Salon.findById(salonId);
						if (salon) await diffuserTable(salonId, salon.toObject());
						repondre({ ok: true, solde: compte.montant });
				} catch (err) {
						console.error(err);
						console.error("Erreur du serveur : game:miser.");
						repondre({ error: "Impossible de miser pour le moment." });
				}
		});

		// Le joueur quitte volontairement (le front l'a averti que sa main est perdue) : sa place est retirée tout de suite
		socket.on("leave", async (ack) => {
			const repondre = typeof ack === "function" ? ack : () => { };
			const { salonId, role, user } = socket.data;
			try {
				// On quitte la room d'abord, pour ne plus être compté « en ligne »
				if (salonId) socket.leave(salonId);
				socket.data.salonId = null;
				socket.data.role = null;

				if (salonId && role === "joueur") {
					annulerDepart(salonId, user.id);
					await retirerJoueur(salonId, user.id);
				}
				repondre({ ok: true });
			} catch (err) {
				console.error(err);
				repondre({ error: "Erreur du serveur : leave." });
			}
		});

		// Le dealer (créateur) ferme le salon depuis la table : mêmes règles que DELETE /deleteSalon
		socket.on("salon:close", async (ack) => {
			const repondre = typeof ack === "function" ? ack : () => { };
			const { salonId, role } = socket.data;
			if (!salonId || role !== "dealer")
				return repondre({ error: "Seul le dealer de ce salon peut le fermer." });
			try {
				const salon = await Salon.findById(salonId);
				if (!salon) return repondre({ error: "Salon introuvable." });
				if (salon.status === "playing")
					return repondre({
						error: "Le salon ne peut pas être fermé pendant une partie.",
					});
				await Salon.findByIdAndDelete(salonId);
				notifierSalonFerme(salonId);
				repondre({ ok: true });
			} catch (err) {
				console.error(err);
				repondre({ error: "Erreur du serveur : salon:close." });
			}
		});

		// Image JPEG de la caméra, envoyée seulement par le dealer du salon
		socket.on("frame", (image) => {
			const { salonId, role } = socket.data;
			if (!salonId || role !== "dealer" || !Buffer.isBuffer(image)) return;
			socket.to(salonId).volatile.emit("frame", image); // joueurs / spectateurs
			io.to("detection").volatile.emit("frame", { salonId, image }); // service Python
		});

		// Joueur parti sans prévenir (onglet fermé, réseau, rafraîchissement) : il a delaiRetourMs pour revenir,
		// sinon sa place (et sa main) est retirée
		socket.on("disconnect", async () => {
			const { salonId, role, user } = socket.data;
			if (!salonId || role !== "joueur") return;
			const connexions = await io.in(salonId).fetchSockets();
			if (connexions.some((connexion) => String(connexion.data.user?.id) === String(user.id)))
				return; // un autre onglet est encore là

			const salon = await Salon.findById(salonId);
			if (salon) await diffuserTable(salonId, salon.toObject());
			annulerDepart(salonId, user.id);
			departs.set(
				`${salonId}:${user.id}`,
				setTimeout(() => {
					departs.delete(`${salonId}:${user.id}`);
					retirerJoueur(salonId, user.id).catch((err) => console.error(err));
				}, delaiRetourMs),
			);
		});

		// Lobby (Salon.jsx) : reçoit "salons:changed" quand la liste change. Ouvert aux invités, aucune donnée envoyée
		socket.on("lobby:rejoindre", () => socket.join("lobby"));
		socket.on("lobby:quitter", () => socket.leave("lobby"));
	});

	return io;
}

module.exports = { initialiserSocketServer, notifierSalonFerme, notifierLobby };

const { Server } = require("socket.io");
const mongoose = require("mongoose");
const Salon = require("../models/salon");
const Compte = require("../models/compte");
const Transaction = require("../models/transaction");
const { lireToken } = require("../fonctionsCommunes");
const { roleDansSalon, vuePourRole } = require("../jeux/vueTable");
const { attribuerMains } = require("../jeux/mainsDetectees");
const {
	appliquerDetectionAction,
	activerProchainTour,
	demarrerManche: preparerManche,
	initialiserTourSiPret,
	jouerAction,
	mancheTerminee,
	resultatMain,
	terminerSurBlackjackCroupier,
} = require("../jeux/partieDetectee");
const { retourJoueur } = require("../jeux/reglementSalon");
const { initialiserChat } = require("./chat");

let io = null; // gardé pour notifierSalonFerme (appelé depuis la route DELETE /deleteSalon)
const departs = new Map(); // "salonId:compteId" -> minuterie d'un joueur déconnecté sans prévenir
const debutsManche = new Map(); // salonId -> { minuterie, debut } : délai des mises avant la manche
const reglementsEnCours = new Set();
const verrousSalon = new Map();

async function avecVerrouSalon(salonId, action) {
	const precedent = verrousSalon.get(salonId) ?? Promise.resolve();
	let liberer;
	const barriere = new Promise((resolve) => {
		liberer = resolve;
	});
	const prochain = precedent.then(() => barriere);
	verrousSalon.set(salonId, prochain);
	await precedent;
	try {
		return await action();
	} finally {
		liberer();
		if (verrousSalon.get(salonId) === prochain) verrousSalon.delete(salonId);
	}
}

function avecDebutManche(salonId, salon) {
    return { ...salon, debut_manche: debutsManche.get(salonId)?.debut ?? null };
}

/** Entrées : room du salon et salon (objet); sortie : aucune. Chaque connexion de la room reçoit la vue de son rôle. */
async function diffuserTable(salonId, salon) {
	const connexions = await io.in(salonId).fetchSockets();
	for (const connexion of connexions) {
		connexion.emit("game:update", {
			salon: vuePourRole(avecDebutManche(salonId, salon), connexion.data.role),
			message: `Mise à jour de la table pour le salon ${salonId}`,
		});
	}
}

/** Entrées : salon et compte; retire le joueur (sa main est perdue), sauvegarde et prévient la table. */
async function retirerJoueur(salonId, compteId) {
	return avecVerrouSalon(String(salonId), () => retirerJoueurVerrouille(salonId, compteId));
}

async function retirerJoueurVerrouille(salonId, compteId) {
	const salon = await Salon.findById(salonId);
	if (!salon) return;
	const joueurRetire = salon.players.find((player) => String(player.id_compte) === String(compteId));
	const restants = salon.players.filter(
		(player) => String(player.id_compte) !== String(compteId),
	);
	if (restants.length === salon.players.length) return; // déjà parti
	salon.players = restants;
	if (joueurRetire?.isTurn && salon.status === "playing") {
		activerProchainTour(salon, joueurRetire.seat_index);
	}
	salon.updated_at = new Date();
	await salon.save();
	if (salon.status === "playing" && mancheTerminee(salon)) {
		const salonRegle = await reglerManche(String(salon._id));
		if (salonRegle) return diffuserTable(String(salon._id), salonRegle.toObject());
	}
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
	return avecVerrouSalon(String(salonId), async () => {
		const salon = await Salon.findOne({ _id: salonId, status: "waiting", "players.bet": { $gt: 0 } });
		if (salon) {
			preparerManche(salon);
			salon.updated_at = new Date();
			await salon.save();
		}
		// Plus aucune mise (joueurs partis) : rien ne démarre, mais la table doit voir le compte à rebours disparaître
		const salonFinal = salon ?? (await Salon.findById(salonId));
		if (salonFinal) await diffuserTable(salonId, salonFinal.toObject());
	});
}

function copierCartes(salon) {
	return {
		dealer: [...(salon.dealer_hand ?? [])],
		joueurs: new Map(salon.players.map((player) => [
			String(player.id_compte),
			[...(player.hands?.[0]?.cartes ?? [])],
		])),
	};
}

function restaurerCartesJoueur(player, cartes) {
	if (!player.hands?.[0]) return;
	player.hands[0].cartes = cartes;
}

async function reglerManche(salonId) {
	if (reglementsEnCours.has(salonId)) return null;
	reglementsEnCours.add(salonId);
	const mouvements = [];
	let salon;
	try {
		const verrou = await Salon.findOneAndUpdate(
			{ _id: salonId, status: "playing" },
			{ $set: { status: "settling" } },
			{ new: true },
		);
		if (!verrou) return null;
		salon = verrou;

		for (const player of salon.players) {
			if (Number(player.bet) <= 0) continue;
			const retour = retourJoueur(player, salon.dealer_hand);
			const resultat = player.hands?.[0]
				? resultatMain(player.hands[0], salon.dealer_hand)
				: "perdu";
			player.resultats = [resultat];
			player.status = "finished";
			player.isTurn = false;
			player.pendingAction = null;
			player.pendingCardCount = null;

			if (retour > 0) {
				const compte = await Compte.findByIdAndUpdate(
					player.id_compte,
					{ $inc: { montant: retour } },
					{ new: true },
				);
				if (!compte) throw new Error(`Compte introuvable pour régler le siège ${player.seat_index}.`);
				const mouvement = { id_compte: player.id_compte, montant: retour, transactionId: null };
				mouvements.push(mouvement);
				const transaction = await Transaction.create({
					id_compte: player.id_compte,
					desc: "Retour et gain blackjack en salon",
					montant: retour,
				});
				mouvement.transactionId = transaction._id;
			}
			player.bet = 0;
		}

		salon.status = "finished";
		salon.currentTurnSeat = 0;
		salon.dealComplete = false;
		salon.updated_at = new Date();
		await salon.save();
		return salon;
	} catch (error) {
		for (const mouvement of mouvements.reverse()) {
			await Compte.findByIdAndUpdate(mouvement.id_compte, { $inc: { montant: -mouvement.montant } });
			if (mouvement.transactionId) await Transaction.findByIdAndDelete(mouvement.transactionId);
		}
		if (salon) {
			await Salon.updateOne({ _id: salonId, status: "settling" }, { $set: { status: "playing" } });
		}
		throw error;
	} finally {
		reglementsEnCours.delete(salonId);
	}
}

async function traiterCartesDetectees(salon, mainsDetectees) {
	const avant = copierCartes(salon);
	attribuerMains(salon, mainsDetectees);
	if (salon.status === "playing" && salon.dealComplete && !mainsDetectees.croupier) {
		salon.dealer_hand = avant.dealer;
	}

	if (salon.status !== "playing") return;
	if (!salon.dealComplete) {
		initialiserTourSiPret(salon);
		return;
	}

	for (const player of salon.players) {
		if (Number(player.bet) <= 0) continue;
		const anciennesCartes = avant.joueurs.get(String(player.id_compte)) ?? [];
		const cartes = player.hands?.[0]?.cartes ?? [];
		if (player.pendingAction) {
			if (cartes.length <= Number(player.pendingCardCount)) {
				if (cartes.length !== anciennesCartes.length) restaurerCartesJoueur(player, anciennesCartes);
				continue;
			}
			appliquerDetectionAction(salon);
		} else if (cartes.length !== anciennesCartes.length) {
			restaurerCartesJoueur(player, anciennesCartes);
		}
	}

	terminerSurBlackjackCroupier(salon);
	const joueursEncoreActifs = salon.players.some(
		(player) => Number(player.bet) > 0 && (player.status === "playing" || player.pendingAction),
	);
	const revelationDeuxiemeCarte = avant.dealer.length < 2 && salon.dealer_hand.length === 2;
	const retraitCarteCroupier = salon.dealer_hand.length < avant.dealer.length;
	const tirageCroupierPendantTour = joueursEncoreActifs
		&& salon.dealer_hand.length > avant.dealer.length
		&& !revelationDeuxiemeCarte;
	if (retraitCarteCroupier || tirageCroupierPendantTour) {
		salon.dealer_hand = avant.dealer;
	}
}

/** Entrée : id du salon supprimé; prévient la table ("salon:closed") et vide sa room. */
function notifierSalonFerme(salonId) {
	if (!io) return;
	const room = String(salonId);
	io.to(room).emit("salon:closed", { salonId: room });
	io.in(room).socketsLeave(room);
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
 * Entrées : serveur HTTP et options (delaiRetourMs, delaiMisesMs);
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

					await avecVerrouSalon(String(salonId), async () => {
						const salon = await Salon.findById(salonId);
						if (!salon)
							return console.error(
								`Salon introuvable pour cartes (service de détection) : ${salonId}`,
							);
						if (salon.status === "finished" || salon.status === "settling") return;

						// Les données du service restent inchangées; les règles valident leur effet sur la manche.
						await traiterCartesDetectees(salon, mains);
						salon.updated_at = new Date();
						await salon.save();
						if (salon.status === "playing" && mancheTerminee(salon)) {
							const salonRegle = await reglerManche(String(salon._id));
							if (salonRegle) return diffuserTable(String(salon._id), salonRegle.toObject());
						}
						await diffuserTable(String(salon._id), salon.toObject());
					});
				} catch (err) {
					console.error(err);
					console.error("Erreur du serveur : cartes (service de détection).");
					if (salonId) io.to(String(salonId)).emit("game:error", { message: "Impossible de traiter les cartes détectées." });
				}
			});
			return; // pas besoin des handlers des navigateurs
		}

		initialiserChat(io, socket);

		// Navigateur : connecté (token valide) ou invité (pas de token → user = null)
		socket.data.user = lireToken(socket.handshake.auth?.token);

		// Le rôle (dealer, joueur, spectateur) est calculé ici à partir du token, jamais envoyé par le client
		socket.on("join", async (salonId, ack) => {
			const repondre = typeof ack === "function" ? ack : () => {}; // Blackjack.jsx n'attend pas de réponse
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
			} catch (err) {
				console.error(err);
				repondre({ error: "Erreur du serveur : join." });
			}
		});

		// Ancien client blackjack : rediffuse uniquement l'état déjà sauvegardé, sans faire confiance au payload client.
		socket.on("game:action", async () => {
			const { salonId, role } = socket.data;
			if (!salonId || (role !== "joueur" && role !== "dealer")) return;
			try {
				const salon = await Salon.findById(salonId);
				if (salon) await diffuserTable(salonId, salon.toObject());
			} catch (err) {
				console.error(err);
			}
		});

		socket.on("game:move", async ({ action } = {}, ack) => {
			const repondre = typeof ack === "function" ? ack : () => {};
			const { salonId, role, user } = socket.data;
			if (!salonId || role !== "joueur" || !user?.id) {
				return repondre({ error: "Seul un joueur du salon peut jouer." });
			}
			let repondu = false;
			try {
				await avecVerrouSalon(salonId, async () => {
					const salon = await Salon.findById(salonId);
					if (!salon) return repondre({ error: "Salon introuvable." });
					const actionResultat = jouerAction(salon, user.id, action);
					if (actionResultat.error) return repondre({ error: actionResultat.error });

					let compte = null;
					let transaction = null;
					try {
						if (actionResultat.miseSupplementaire > 0) {
							compte = await Compte.findOneAndUpdate(
								{ _id: user.id, montant: { $gte: actionResultat.miseSupplementaire } },
								{ $inc: { montant: -actionResultat.miseSupplementaire } },
								{ new: true },
							);
							if (!compte) {
								return repondre({ error: "Solde insuffisant pour doubler." });
							}
							transaction = await Transaction.create({
								id_compte: user.id,
								desc: "Double blackjack en salon",
								montant: -actionResultat.miseSupplementaire,
							});
						}
						salon.updated_at = new Date();
						await salon.save();
					} catch (error) {
						if (compte) {
							await Compte.findByIdAndUpdate(user.id, { $inc: { montant: actionResultat.miseSupplementaire } });
						}
						if (transaction) await Transaction.findByIdAndDelete(transaction._id);
						throw error;
					}

					repondre({ ok: true, solde: compte?.montant });
					repondu = true;
					await diffuserTable(salonId, salon.toObject());
					if (mancheTerminee(salon)) {
						const salonRegle = await reglerManche(salonId);
						if (salonRegle) await diffuserTable(salonId, salonRegle.toObject());
					}
				});
			} catch (err) {
				console.error(err);
				if (!repondu) repondre({ error: "Impossible d’enregistrer votre action." });
			}
		});

		socket.on("game:miser", async ({ mise } = {}, ack) => {
				const repondre = typeof ack === "function" ? ack : () => {};
				const { salonId, role, user } = socket.data;
				if (!salonId || role !== "joueur")
						return repondre({ error: "Seul un joueur du salon peut miser." });
				if (typeof mise !== "number" || !Number.isFinite(mise) || mise <= 0)
						return repondre({ error: "Mise invalide." });
				const montant = Math.round(mise * 100) / 100; // au cent près

				let reservation = false;
				let compte = null;
				let transaction = null;
				let validee = false;
				let repondu = false;
				try {
						// 1. Réserver la mise : ne passe que si la manche n'est pas commencée et que le joueur n'a pas déjà misé
						const reserve = await Salon.updateOne(
								{
										_id: salonId,
										status: { $in: ["waiting", "finished"] },
										players: { $elemMatch: { id_compte: user.id, bet: 0 } },
								},
								{ $set: { "players.$.bet": montant, status: "waiting", updated_at: new Date() } },
						);
						if (reserve.modifiedCount === 0)
								return repondre({ error: "Mise impossible (manche en cours ou déjà misé)." });
						reservation = true;

						// 2. Débiter le compte seulement si le solde suffit (une seule opération Mongo : pas de double débit)
						compte = await Compte.findOneAndUpdate(
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
								reservation = false;
								return repondre({ error: "Solde insuffisant." });
						}
						transaction = await Transaction.create({ id_compte: user.id, desc: "Mise blackjack en salon", montant: -montant });
						validee = true;
						// Première mise de la manche : has puis set sans await entre les deux, donc une seule minuterie même si deux joueurs misent en même temps
						if (!debutsManche.has(salonId)) planifierDebut(salonId, delaiMisesMs);
						repondre({ ok: true, solde: compte.montant });
						repondu = true;
						const salon = await Salon.findById(salonId);
						if (salon) await diffuserTable(salonId, salon.toObject());
				} catch (err) {
						console.error(err);
						console.error("Erreur du serveur : game:miser.");
						if (!validee) {
								if (transaction) await Transaction.findByIdAndDelete(transaction._id);
								if (compte) await Compte.findByIdAndUpdate(user.id, { $inc: { montant } });
								if (reservation) {
										await Salon.updateOne(
												{
														_id: salonId,
														players: { $elemMatch: { id_compte: user.id, bet: montant } },
												},
												{ $set: { "players.$.bet": 0 } },
										);
								}
						}
						if (!repondu) repondre({ error: "Impossible de miser pour le moment." });
				}
		});

		// Le joueur quitte volontairement (le front l'a averti que sa main est perdue) : sa place est retirée tout de suite
		socket.on("leave", async (ack) => {
			const repondre = typeof ack === "function" ? ack : () => {};
			const { salonId, role, user } = socket.data;
			try {
				if (salonId && role === "joueur") {
					annulerDepart(salonId, user.id);
					await retirerJoueur(salonId, user.id);
				}
				if (salonId) socket.leave(salonId);
				socket.data.salonId = null;
				socket.data.role = null;
				repondre({ ok: true });
			} catch (err) {
				console.error(err);
				repondre({ error: "Erreur du serveur : leave." });
			}
		});

		// Le dealer (créateur) ferme le salon depuis la table : mêmes règles que DELETE /deleteSalon
		socket.on("salon:close", async (ack) => {
			const repondre = typeof ack === "function" ? ack : () => {};
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
			annulerDepart(salonId, user.id);
			departs.set(
				`${salonId}:${user.id}`,
				setTimeout(() => {
					departs.delete(`${salonId}:${user.id}`);
					retirerJoueur(salonId, user.id).catch((err) => console.error(err));
				}, delaiRetourMs),
			);
		});
	});

	return io;
}

module.exports = { initialiserSocketServer, notifierSalonFerme };

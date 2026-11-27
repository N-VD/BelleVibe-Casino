const { Server } = require("socket.io");
const mongoose = require("mongoose");
const Salon = require("../models/salon");
const Compte = require("../models/compte");
const Transaction = require("../models/transaction");
const { lireToken } = require("../fonctionsCommunes");
const { roleDansSalon, vuePourRole } = require("../jeux/vueTable");
const { appliquerCartesDetectees, avancerTour } = require("../jeux/partieSalon");
const { tenterReglementManche } = require("../jeux/reglementManche");
const { initialiserChat } = require("./chat");

let io = null; // gardé pour notifierSalonFerme (appelé depuis la route DELETE /deleteSalon)
const departs = new Map(); // "salonId:compteId" -> minuterie d'un joueur déconnecté sans prévenir
const retraitsEnAttente = new Map(); // départs différés pendant le verrou du règlement
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

/** Diffuse un salon déjà sauvegardé, avec la vue appropriée à chaque rôle. */
async function notifierSalonMisAJour(salon) {
	if (!io || !salon) return;
	const donnees = typeof salon.toObject === "function" ? salon.toObject() : salon;
	const salonId = String(donnees._id ?? donnees.id);
	await diffuserTable(salonId, donnees);
}

function prochaineDate(date) {
	const precedent = date ? new Date(date).getTime() : 0;
	return new Date(Math.max(Date.now(), precedent + 1));
}

/** Enregistre une détection seulement si le salon n'a pas changé entre lecture et écriture. */
async function traiterDetection(salonId, mains) {
	for (let tentative = 0; tentative < 3; tentative++) {
		const salon = await Salon.findById(salonId);
		if (!salon) return null;

		const datePrecedente = salon.updated_at;
		if (!appliquerCartesDetectees(salon, mains)) return null;
		salon.updated_at = prochaineDate(datePrecedente);
		const salonMisAJour = await Salon.findOneAndUpdate(
			{ _id: salonId, status: salon.status, updated_at: datePrecedente },
			{
				$set: {
					dealer_hand: salon.dealer_hand,
					players: salon.players,
					currentTurnSeat: salon.currentTurnSeat,
					updated_at: salon.updated_at,
				},
			},
			{ new: true, runValidators: true },
		);
		if (salonMisAJour) return salonMisAJour;
	}
	throw new Error(`Impossible d'enregistrer la détection du salon ${salonId} après plusieurs tentatives.`);
}

/** Retire le joueur sans écraser un règlement ou une mise à jour concurrente du salon. */
async function retirerJoueur(salonId, compteId, tentativeReglement = 0) {
	const cle = `${salonId}:${compteId}`;
	for (let tentative = 0; tentative < 3; tentative++) {
		const salon = await Salon.findById(salonId);
		if (!salon) {
			retraitsEnAttente.delete(cle);
			return;
		}
		if (tentativeReglement > 0 && !retraitsEnAttente.has(cle)) return;
		if (salon.status === "settling") {
			if (tentativeReglement >= 20) {
				console.error(`Le retrait du joueur ${compteId} reste en attente du règlement du salon ${salonId}.`);
				retraitsEnAttente.delete(cle);
				return;
			}
			if (!retraitsEnAttente.get(cle)) {
				const minuterie = setTimeout(() => {
					if (!retraitsEnAttente.has(cle)) return;
					retraitsEnAttente.set(cle, null);
					retirerJoueur(salonId, compteId, tentativeReglement + 1)
						.catch((erreurRetrait) => console.error("Erreur du retrait différé :", erreurRetrait));
				}, 100);
				retraitsEnAttente.set(cle, minuterie);
			}
			return;
		}

		const statutPrecedent = salon.status;
		const restants = salon.players.filter(
			(player) => String(player.id_compte) !== String(compteId),
		);
		if (restants.length === salon.players.length) {
			retraitsEnAttente.delete(cle);
			return; // déjà parti
		}
		salon.players = restants;
		if (salon.status === "playing") {
			avancerTour(salon);
			if (!salon.players.some((player) => Number(player.bet) > 0)) {
				salon.status = "finished";
				salon.currentTurnSeat = -1;
			}
		}

		const salonMisAJour = await Salon.findOneAndUpdate(
			{ _id: salonId, status: statutPrecedent, updated_at: salon.updated_at },
			{
				$set: {
					status: salon.status,
					players: salon.players,
					currentTurnSeat: salon.currentTurnSeat,
					updated_at: prochaineDate(salon.updated_at),
				},
			},
			{ new: true, runValidators: true },
		);
		if (!salonMisAJour) continue;

		retraitsEnAttente.delete(`${salonId}:${compteId}`);
		await notifierSalonMisAJour(salonMisAJour);
		if (salonMisAJour.status === "playing") {
			try {
				await tenterReglementManche(String(salonMisAJour._id), notifierSalonMisAJour);
			} catch (erreurReglement) {
				console.error("Erreur du règlement blackjack après le départ d'un joueur :", erreurReglement);
			}
		}
		return;
	}
	retraitsEnAttente.delete(cle);
	throw new Error(`Impossible d'enregistrer le départ du joueur ${compteId} du salon ${salonId}.`);
}

function annulerDepart(salonId, compteId) {
	const cle = `${salonId}:${compteId}`;
	clearTimeout(departs.get(cle));
	departs.delete(cle);
	clearTimeout(retraitsEnAttente.get(cle));
	retraitsEnAttente.delete(cle);
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
        const salon =
                (await Salon.findOneAndUpdate(
                        { _id: salonId, status: "waiting", "players.bet": { $gt: 0 } },
                        {
							$set: {
								status: "playing",
								dealer_hand: [],
								currentTurnSeat: -1,
								"players.$[].hands": [],
								"players.$[].resultats": [],
								"players.$[].activeHand": 0,
								"players.$[].status": "waiting",
								"players.$[].pendingAction": null,
								"players.$[].isTurn": false,
								updated_at: new Date(),
							},
						},
                        { new: true },
                ))
                // Plus aucune mise (joueurs partis) : rien ne démarre, mais la table doit voir le compte à rebours disparaître
                ?? (await Salon.findById(salonId));
        if (salon) await diffuserTable(salonId, salon.toObject());
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

					// Les snapshots complets avancent les mains; une carte attendue n'est validée qu'une fois détectée.
					const salonMisAJour = await traiterDetection(String(salon._id), mains);
					if (!salonMisAJour) return;
					await notifierSalonMisAJour(salonMisAJour);
					try {
						await tenterReglementManche(String(salon._id), notifierSalonMisAJour);
					} catch (erreurReglement) {
						console.error("Erreur du règlement blackjack après détection :", erreurReglement);
					}
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

		socket.on("game:miser", async ({ mise } = {}, ack) => {
				const repondre = typeof ack === "function" ? ack : () => {};
				const { salonId, role, user } = socket.data;
				if (!salonId || role !== "joueur")
						return repondre({ error: "Seul un joueur du salon peut miser." });
				if (typeof mise !== "number" || !Number.isFinite(mise) || mise <= 0)
						return repondre({ error: "Mise invalide." });
				const montant = Math.round(mise * 100) / 100; // au cent près
				if (montant <= 0)
						return repondre({ error: "La mise doit être d’au moins un cent." });
				let miseReservee = false;
				let compteDebite = false;
				let transaction = null;

				try {
						// Une nouvelle mise après la manche terminée réinitialise la table avant de la réserver.
						await Salon.updateOne(
								{ _id: salonId, status: "finished" },
								{
										$set: {
												status: "waiting",
												dealer_hand: [],
												currentTurnSeat: -1,
												"players.$[].hands": [],
												"players.$[].resultats": [],
												"players.$[].activeHand": 0,
												"players.$[].bet": 0,
												"players.$[].status": "waiting",
												"players.$[].pendingAction": null,
												"players.$[].isTurn": false,
												updated_at: new Date(),
										},
								},
						);

						// Réserver la mise seulement pendant la période d'attente et une fois par joueur.
						const reserve = await Salon.updateOne(
								{
										_id: salonId,
										status: "waiting",
										players: { $elemMatch: { id_compte: user.id, bet: 0 } },
								},
								{ $set: { "players.$.bet": montant, updated_at: new Date() } },
						);
						if (reserve.modifiedCount === 0)
								return repondre({ error: "Mise impossible (manche en cours ou déjà misé)." });
						miseReservee = true;

						// 2. Débiter le compte seulement si le solde suffit (une seule opération Mongo : pas de double débit)
						const compte = await Compte.findOneAndUpdate(
								{ _id: user.id, montant: { $gte: montant } },
								{ $inc: { montant: -montant } },
								{ new: true },
						);
						if (!compte) {
								await libererMiseReservee();
								return repondre({ error: "Solde insuffisant." });
						}
						compteDebite = true;
						transaction = await Transaction.create({
								id_compte: user.id,
								desc: "Mise blackjack en salon",
								montant: -montant,
						});
						// Première mise de la manche : has puis set sans await entre les deux, donc une seule minuterie même si deux joueurs misent en même temps
						if (!debutsManche.has(salonId)) planifierDebut(salonId, delaiMisesMs);
						
						const salon = await Salon.findById(salonId);
						if (salon) {
								try {
										await notifierSalonMisAJour(salon);
								} catch (erreurDiffusion) {
										console.error("Échec de diffusion de la mise blackjack :", erreurDiffusion);
								}
						}
						repondre({ ok: true, solde: compte.montant });
				} catch (err) {
						if (transaction) {
								try {
										await Transaction.findByIdAndDelete(transaction._id);
								} catch (erreurTransaction) {
										console.error("Échec de l’annulation de la transaction de mise :", erreurTransaction);
								}
						}
						if (compteDebite) {
								try {
										await Compte.findByIdAndUpdate(user.id, { $inc: { montant } });
								} catch (erreurCompte) {
										console.error("Échec du remboursement de la mise blackjack :", erreurCompte);
								}
						}
						if (miseReservee) await libererMiseReservee();
						console.error(err);
						console.error("Erreur du serveur : game:miser.");
						repondre({ error: "Impossible de miser pour le moment." });
				}

				/** Annule la réservation si le débit ou l'enregistrement de la mise échoue. */
				async function libererMiseReservee() {
						try {
								await Salon.updateOne(
										{ _id: salonId, status: "waiting", "players.id_compte": user.id },
										{ $set: { "players.$.bet": 0, updated_at: new Date() } },
								);
						} catch (erreurReservation) {
								console.error("Échec de la libération de la mise blackjack :", erreurReservation);
						}
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
				const salonSupprime = await Salon.findOneAndDelete({
					_id: salonId,
					status: { $nin: ["playing", "settling"] },
				});
				if (!salonSupprime)
					return repondre({
						error: "Le salon ne peut pas être fermé pendant une partie.",
					});
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
	});

	return io;
}

module.exports = {
	initialiserSocketServer,
	notifierSalonFerme,
	notifierSalonMisAJour,
	retirerJoueur,
	annulerDepart,
};

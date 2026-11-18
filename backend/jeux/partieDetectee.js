const NB_SIEGES = 6;
const { valeurMain } = require("./reglementSalon");

function joueursAvecMise(salon) {
	return salon.players.filter((player) => Number(player.bet) > 0);
}

function demarrerManche(salon) {
	salon.status = "playing";
	salon.dealer_hand = [];
	salon.dealComplete = false;
	salon.currentTurnSeat = 0;
	for (const player of salon.players) {
		player.hands = [];
		player.resultats = [];
		player.pendingAction = null;
		player.pendingCardCount = null;
		player.status = Number(player.bet) > 0 ? "playing" : "waiting";
		player.isTurn = false;
	}
}

function prochainJoueur(salon, siegePrecedent = -1) {
	const joueurs = joueursAvecMise(salon)
		.filter((player) => player.status === "playing" && !player.pendingAction)
		.sort((a, b) => {
			const distanceA = siegePrecedent < 0
				? a.seat_index
				: (a.seat_index - siegePrecedent + NB_SIEGES) % NB_SIEGES;
			const distanceB = siegePrecedent < 0
				? b.seat_index
				: (b.seat_index - siegePrecedent + NB_SIEGES) % NB_SIEGES;
			return distanceA - distanceB;
		});
	return joueurs[0] ?? null;
}

function attribuerTour(salon, joueur) {
	for (const player of salon.players) player.isTurn = player === joueur;
	salon.currentTurnSeat = joueur?.seat_index ?? 0;
}

function activerProchainTour(salon, siegePrecedent) {
	const joueur = prochainJoueur(salon, siegePrecedent);
	attribuerTour(salon, joueur);
	return joueur;
}

function initialiserTourSiPret(salon) {
	if (salon.status !== "playing" || salon.dealComplete) return false;
	const joueurs = joueursAvecMise(salon);
	if (
		joueurs.length === 0
		|| salon.dealer_hand.length < 1
		|| joueurs.some((player) => !player.hands?.[0] || player.hands[0].cartes?.length < 2)
	) return false;

	salon.dealComplete = true;
	for (const player of joueurs) {
		const main = player.hands[0];
		const naturel = main.cartes.length === 2 && valeurMain(main.cartes) === 21;
		main.naturel = naturel;
		main.status = naturel ? "blackjack" : "playing";
		player.status = naturel ? "stand" : "playing";
	}
	if (blackjackCroupier(salon)) {
		for (const player of joueurs) {
			if (player.status === "playing") {
				player.status = "stand";
				player.hands[0].status = "stand";
			}
		}
	}
	activerProchainTour(salon, -1);
	return true;
}

function blackjackCroupier(salon) {
	return salon.dealer_hand.length === 2 && valeurMain(salon.dealer_hand) === 21;
}

function terminerSurBlackjackCroupier(salon) {
	if (!salon.dealComplete || !blackjackCroupier(salon)) return false;
	for (const player of joueursAvecMise(salon)) {
		if (player.status !== "playing" && !player.pendingAction) continue;
		player.status = "stand";
		player.isTurn = false;
		player.pendingAction = null;
		player.pendingCardCount = null;
		if (player.hands?.[0]) player.hands[0].status = "stand";
	}
	attribuerTour(salon, null);
	return true;
}

function jouerAction(salon, idCompte, action) {
	if (salon.status !== "playing" || !salon.dealComplete) {
		return { error: "La manche n’est pas prête pour une action." };
	}
	const joueur = salon.players.find((player) => String(player.id_compte) === String(idCompte));
	if (!joueur || !joueur.isTurn || joueur.seat_index !== salon.currentTurnSeat) {
		return { error: "Ce n’est pas votre tour." };
	}
	if (joueur.pendingAction) return { error: "Attendez la détection de votre action précédente." };
	if (joueur.status !== "playing") return { error: "Votre main n’est plus en cours." };
	const main = joueur.hands?.[0];
	if (!main || !Array.isArray(main.cartes) || main.cartes.length < 2) {
		return { error: "Il faut au moins deux cartes détectées pour jouer cette main." };
	}

	if (action === "stand") {
		main.status = "stand";
		joueur.status = "stand";
		joueur.isTurn = false;
		activerProchainTour(salon, joueur.seat_index);
		return { ok: true, miseSupplementaire: 0 };
	}
	if (action !== "hit" && action !== "double") {
		return { error: "Action inconnue." };
	}
	if (action === "double" && main.cartes.length !== 2) {
		return { error: "Le double est permis seulement après les deux premières cartes." };
	}

	main.status = "playing";
	const miseSupplementaire = action === "double" ? Number(joueur.bet) : 0;
	if (action === "double") {
		joueur.bet = Math.round((Number(joueur.bet) + miseSupplementaire) * 100) / 100;
		main.mise = joueur.bet;
		main.double = true;
	}
	joueur.pendingAction = action;
	joueur.pendingCardCount = main.cartes.length;
	return { ok: true, miseSupplementaire };
}

function appliquerDetectionAction(salon) {
	const joueur = salon.players.find((player) => player.pendingAction);
	if (!joueur) return false;
	const main = joueur.hands?.[0];
	if (!main || main.cartes.length <= Number(joueur.pendingCardCount)) return false;

	const action = joueur.pendingAction;
	const total = valeurMain(main.cartes);
	main.naturel = false;
	main.status = total > 21 ? "bust" : action === "double" || total === 21 ? "stand" : "playing";
	joueur.status = main.status === "playing" ? "playing" : main.status;
	joueur.pendingAction = null;
	joueur.pendingCardCount = null;
	if (main.status !== "playing") {
		joueur.isTurn = false;
		activerProchainTour(salon, joueur.seat_index);
	}
	return true;
}

function mancheTerminee(salon) {
	const joueurs = joueursAvecMise(salon);
	if (joueurs.length === 0 || !joueurs.every((player) => ["stand", "bust"].includes(player.status))) {
		return false;
	}
	if (joueurs.every((player) => player.status === "bust")) return true;
	return salon.dealer_hand.length >= 2 && valeurMain(salon.dealer_hand) >= 17;
}

function resultatMain(main, dealerHand) {
	const totalJoueur = valeurMain(main.cartes);
	const totalCroupier = valeurMain(dealerHand);
	const blackjackCroupier = dealerHand.length === 2 && totalCroupier === 21;
	if (totalJoueur > 21) return "perdu";
	if (main.naturel && blackjackCroupier) return "egalite";
	if (main.naturel) return "blackjack";
	if (blackjackCroupier) return "perdu";
	if (totalCroupier > 21 || totalJoueur > totalCroupier) return "gagne";
	if (totalJoueur === totalCroupier) return "egalite";
	return "perdu";
}

module.exports = {
	appliquerDetectionAction,
	activerProchainTour,
	demarrerManche,
	initialiserTourSiPret,
	jouerAction,
	mancheTerminee,
	resultatMain,
	terminerSurBlackjackCroupier,
	valeurMain,
};

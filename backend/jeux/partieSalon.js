const {
    actionsPossibles,
    arrondir,
    jouer,
    terminer,
    valeurMain,
} = require('./blackjack');
const { versCartes } = require('./mainsDetectees');

const SIEGE_INACTIF = -1;
const ACTIONS = new Set(['hit', 'stand', 'double']);
const STATUTS_TERMINAUX = new Set(['stand', 'bust', 'blackjack']);
const RANGS = new Set(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);

/** Attache un code HTTP aux erreurs de règles pour que la route réponde précisément. */
function erreur(message, status = 400) {
    const resultat = new Error(message);
    resultat.status = status;
    return resultat;
}

/** Retourne les joueurs ayant misé dans l'ordre des sièges, celui de la caméra. */
function joueursAvecMise(salon) {
    return [...salon.players]
        .filter((player) => Number(player.bet) > 0)
        .sort((a, b) => a.seat_index - b.seat_index);
}

/** Convertit les statuts persistés vers ceux utilisés par le moteur pur. */
function statutMoteur(statutJoueur) {
    if (statutJoueur === 'playing') return 'en_cours';
    if (STATUTS_TERMINAUX.has(statutJoueur)) return statutJoueur;
    throw erreur('La main du joueur n’est pas prête.');
}

/** Reconstruit l'état d'une main persistée pour appliquer une règle du moteur. */
function creerEtatJoueur(salon, player) {
    const main = player.hands?.[0];
    if (!main || !Array.isArray(main.cartes)) throw erreur('Les cartes du joueur ne sont pas prêtes.', 409);

    return {
        statut: 'en_cours',
        croupier: salon.dealer_hand ?? [],
        mains: [{
            cartes: [...main.cartes],
            mise: Number(main.mise ?? player.bet),
            statut: statutMoteur(player.status),
            double: Boolean(main.double),
            resultat: main.resultat ?? null,
            gain: Number(main.gain ?? 0),
        }],
        mainActive: 0,
    };
}

/** Recopie le résultat du moteur dans les champs persistés du joueur. */
function synchroniserMain(player, partie) {
    const main = partie.mains[0];
    const statut = main.statut === 'en_cours' ? 'playing' : main.statut;
    player.hands = [{
        ...player.hands[0],
        cartes: [...main.cartes],
        mise: main.mise,
        status: statut,
        naturel: main.statut === 'blackjack',
        double: main.double,
        resultat: main.resultat,
        gain: main.gain,
    }];
    player.status = statut;
}

/** Active le prochain joueur encore en jeu, ou met la table en attente du croupier. */
function avancerTour(salon) {
    const prochain = joueursAvecMise(salon).find((player) => player.status === 'playing');
    salon.currentTurnSeat = prochain?.seat_index ?? SIEGE_INACTIF;
    for (const player of salon.players) {
        player.isTurn = prochain != null && player.seat_index === prochain.seat_index;
    }
}

/** Démarre les tours seulement après la détection complète des mains initiales. */
function initialiserTour(salon) {
    if (salon.status !== 'playing') return false;
    const joueurs = joueursAvecMise(salon);
    if (!joueurs.length || salon.dealer_hand.length < 1) return false;
    if (joueurs.some((player) => player.status !== 'waiting'
        || player.hands?.[0]?.cartes?.length !== 2)) return false;

    const blackjackCroupier = salon.dealer_hand.length === 2
        && valeurMain(salon.dealer_hand) === 21;
    for (const player of joueurs) {
        const main = player.hands[0];
        const naturel = valeurMain(main.cartes) === 21;
        main.status = naturel ? 'blackjack' : blackjackCroupier ? 'stand' : 'playing';
        main.naturel = naturel;
        main.double = false;
        main.resultat = null;
        main.gain = 0;
        player.status = main.status;
        player.pendingAction = null;
    }
    avancerTour(salon);
    return true;
}

/** Valide l'action du joueur et la met en attente si une carte doit être détectée. */
function appliquerActionJoueur(salon, idCompte, action, solde) {
    if (!ACTIONS.has(action)) throw erreur('Action invalide.');
    if (salon.status !== 'playing') throw erreur('Aucune manche n’est en cours.', 409);

    const player = salon.players.find((candidat) => String(candidat.id_compte) === String(idCompte));
    if (!player) throw erreur('Vous ne participez pas à ce salon.', 403);
    if (!player.isTurn || salon.currentTurnSeat !== player.seat_index
        || player.status !== 'playing' || player.pendingAction) {
        throw erreur('Ce n’est pas votre tour ou une carte est déjà attendue.', 409);
    }

    const partie = creerEtatJoueur(salon, player);
    if (!actionsPossibles(partie, solde).includes(action)) {
        throw erreur(action === 'double'
            ? 'Le double est impossible (main ou solde insuffisant).'
            : 'Cette action est impossible.', 409);
    }

    const coutSupplementaire = action === 'double' ? partie.mains[0].mise : 0;
    if (action === 'hit' || action === 'double') {
        player.pendingAction = action;
    } else {
        jouer(partie, action, { solde });
        synchroniserMain(player, partie);
        avancerTour(salon);
    }

    return { coutSupplementaire, player };
}

/** Une main n'est consommée que lorsque le service confirme toutes ses cartes et leurs rangs. */
function mainDetecteeValide(main) {
    return main?.complete === true
        && Array.isArray(main.cartes)
        && main.cartes.every((rang) => RANGS.has(rang));
}

/** Vérifie qu'une détection conserve les cartes déjà confirmées avant d'en ajouter une. */
function memePrefixe(cartes, prefixe) {
    return prefixe.every((carte, index) => carte.rang === cartes[index]?.rang);
}

/** Applique un snapshot complet et ne consomme une action qu'après détection de sa carte. */
function appliquerCartesDetectees(salon, mainsDetectees) {
    if (!mainsDetectees || !Array.isArray(mainsDetectees.joueurs)) {
        throw erreur('Le snapshot de détection est mal formé.');
    }
    if (!['waiting', 'playing'].includes(salon.status)) return false;

    let modifie = false;
    if (mainDetecteeValide(mainsDetectees.croupier)) {
        salon.dealer_hand = versCartes(mainsDetectees.croupier.cartes);
        modifie = true;
    }

    const joueurs = joueursAvecMise(salon);
    // Sans une main complète par joueur misant, l'ordre de la caméra ne permet pas une attribution sûre.
    if (joueurs.length !== mainsDetectees.joueurs.length
        || !mainsDetectees.joueurs.every(mainDetecteeValide)) {
        return modifie;
    }

    joueurs.forEach((player, index) => {
        const cartesDetectees = versCartes(mainsDetectees.joueurs[index].cartes);
        const mainExistante = player.hands?.[0];
        const cartesExistantes = mainExistante?.cartes ?? [];

        if (salon.status === 'waiting' || player.status === 'waiting' || !mainExistante) {
            if (cartesDetectees.length <= 2) {
                player.hands = [{
                    cartes: cartesDetectees,
                    mise: Number(player.bet),
                    status: 'waiting',
                    double: false,
                    naturel: false,
                    resultat: null,
                    gain: 0,
                }];
                modifie = true;
            }
            return;
        }

        if (player.pendingAction) {
            // Une carte en attente doit prolonger la main connue d'exactement une carte.
            if (cartesDetectees.length !== cartesExistantes.length + 1
                || !memePrefixe(cartesDetectees, cartesExistantes)) return;

            const miseAvant = Number(mainExistante.mise);
            const partie = creerEtatJoueur(salon, player);
            jouer(partie, player.pendingAction, {
                carte: cartesDetectees[cartesExistantes.length],
                solde: player.pendingAction === 'double' ? miseAvant : 0,
            });
            synchroniserMain(player, partie);
            if (player.pendingAction === 'double') {
                player.bet = arrondir(Number(player.bet) + miseAvant);
            }
            player.pendingAction = null;
            if (player.status !== 'playing') avancerTour(salon);
            modifie = true;
            return;
        }

        if (player.status === 'playing' && cartesDetectees.length === cartesExistantes.length) {
            if (memePrefixe(cartesDetectees, cartesExistantes)) return;
            player.hands = [{ ...mainExistante, cartes: cartesDetectees }];
            modifie = true;
        }
    });

    if (initialiserTour(salon)) modifie = true;
    return modifie;
}

/** Indique si toutes les mains sont terminées et si la main physique du croupier est suffisante. */
function reglementPret(salon) {
    const joueurs = joueursAvecMise(salon);
    if (!joueurs.length || joueurs.some((player) => !STATUTS_TERMINAUX.has(player.status)
        || player.pendingAction)) return false;

    if (joueurs.every((player) => player.status === 'bust')) return true;
    if (salon.dealer_hand.length < 2) return false;
    if (joueurs.some((player) => player.status === 'stand')) {
        return valeurMain(salon.dealer_hand) >= 17;
    }
    return true;
}

/** Calcule les résultats de tous les joueurs et prépare l'état à sauvegarder. */
function reglerMains(salon) {
    if (!reglementPret(salon)) throw erreur('La main du croupier n’est pas terminée.', 409);

    const historiques = [];
    for (const player of joueursAvecMise(salon)) {
        const partie = creerEtatJoueur(salon, player);
        partie.statut = 'attente_croupier';
        terminer(partie, salon.dealer_hand);
        const main = partie.mains[0];
        player.hands = [{
            ...player.hands[0],
            status: main.statut,
            resultat: main.resultat,
            gain: main.gain,
        }];
        player.resultats = [main.resultat];
        player.status = 'finished';
        player.isTurn = false;
        player.pendingAction = null;
        historiques.push({
            id_compte: player.id_compte,
            hand: main.cartes,
            bet: main.mise,
            outcome: {
                gagne: 'win',
                perdu: 'lose',
                egalite: 'push',
                blackjack: 'blackjack',
            }[main.resultat],
            payout: main.gain,
        });
    }
    salon.currentTurnSeat = SIEGE_INACTIF;
    return historiques;
}

module.exports = {
    appliquerActionJoueur,
    appliquerCartesDetectees,
    avancerTour,
    reglementPret,
    reglerMains,
};

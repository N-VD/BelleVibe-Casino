const RANGS = new Set(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
const CROUPIER_RESTE_A = 17;

/** Refuse les cartes sans rang reconnu pour empêcher un calcul sur une détection invalide. */
function validerCartes(cartes, nom) {
    if (!Array.isArray(cartes) || cartes.some((carte) => !carte || !RANGS.has(carte.rang))) {
        throw new TypeError(`${nom} doit contenir des cartes avec un rang valide.`);
    }
}

/** Retourne la valeur blackjack d'un rang reconnu. */
function valeurCarte(rang) {
    if (rang === 'A') return 11;
    if (['J', 'Q', 'K'].includes(rang)) return 10;
    return Number(rang);
}

/** Calcule le total maximal inférieur ou égal à 21, en réduisant les as de 11 à 1 au besoin. */
function valeurMain(cartes) {
    let total = 0;
    let as = 0;
    for (const carte of cartes) {
        total += valeurCarte(carte.rang);
        if (carte.rang === 'A') as++;
    }
    while (total > 21 && as > 0) {
        total -= 10;
        as--;
    }
    return total;
}

/** Identifie un 21 naturel obtenu avec exactement les deux cartes initiales. */
function estBlackjackNaturel(cartes) {
    return cartes.length === 2 && valeurMain(cartes) === 21;
}

/** Indique si le croupier peut encore avoir un blackjack : seule sa carte visible est connue et c'est un as ou un 10. */
function croupierPeutAvoirBlackjack(cartesCroupier) {
    return cartesCroupier.length < 2
        && (cartesCroupier.length === 0 || valeurCarte(cartesCroupier[0].rang) >= 10);
}

/** Arrondit les montants à deux décimales pour les calculs monétaires. */
function arrondir(montant) {
    return Math.round(montant * 100) / 100;
}

/**
 * Crée une partie à partir des cartes initiales détectées.
 * La caméra peut ne fournir que la carte visible du croupier avant la révélation.
 */
function creerPartie({ mise, cartesJoueur, cartesCroupier }) {
    validerCartes(cartesJoueur, 'cartesJoueur');
    validerCartes(cartesCroupier, 'cartesCroupier');
    // Une main de joueur commence à deux cartes; le croupier peut n'en exposer qu'une avant la révélation.
    if (cartesJoueur.length !== 2 || cartesCroupier.length < 1 || cartesCroupier.length > 2) {
        throw new RangeError('La main initiale doit avoir deux cartes et celle du croupier une ou deux.');
    }
    // Refuse une mise non finie ou qui deviendrait nulle après l'arrondi monétaire.
    if (!Number.isFinite(mise) || arrondir(mise) <= 0) {
        throw new RangeError('La mise doit être un nombre supérieur à zéro.');
    }

    const main = {
        cartes: [...cartesJoueur],
        mise: arrondir(mise),
        statut: estBlackjackNaturel(cartesJoueur) ? 'blackjack' : 'en_cours',
        double: false,
        resultat: null,
        gain: 0,
    };
    const partie = {
        statut: 'en_cours',
        croupier: [...cartesCroupier],
        mains: [main],
        mainActive: 0,
    };

    if (main.statut === 'blackjack' || estBlackjackNaturel(partie.croupier)) {
        partie.statut = 'attente_croupier';
    }
    return partie;
}

/** Retourne les actions permises pour la main active et le solde disponible. */
function actionsPossibles(partie, solde) {
    if (partie.statut !== 'en_cours') return [];
    const main = partie.mains[partie.mainActive];
    if (!main || main.statut !== 'en_cours') return [];

    const actions = ['hit', 'stand'];
    // Le double exige deux cartes initiales et assez de solde pour égaler la mise courante.
    if (main.cartes.length === 2 && Number.isFinite(solde) && solde >= main.mise) {
        actions.push('double');
    }
    return actions;
}

/**
 * Applique une action à la main active. Pour hit/double, carte vient de la détection caméra;
 * le solde est fourni par l'appelant pour autoriser ou refuser le double.
 */
function jouer(partie, action, { carte, solde = 0 } = {}) {
    // Valide aussi le tour et le financement du double avant de modifier la partie.
    if (!actionsPossibles(partie, solde).includes(action)) {
        throw new Error(`Action impossible : ${action}`);
    }

    const main = partie.mains[partie.mainActive];
    if (action === 'stand') {
        main.statut = 'stand';
        partie.statut = 'attente_croupier';
        return partie;
    }

    validerCartes([carte], 'carte');
    main.cartes.push(carte);
    if (action === 'double') {
        main.mise = arrondir(main.mise * 2);
        main.double = true;
        main.statut = valeurMain(main.cartes) > 21 ? 'bust' : 'stand';
        partie.statut = 'attente_croupier';
    } else if (valeurMain(main.cartes) > 21) {
        main.statut = 'bust';
        partie.statut = 'attente_croupier';
    } else if (valeurMain(main.cartes) === 21) {
        main.statut = 'stand';
        partie.statut = 'attente_croupier';
    }
    return partie;
}

/**
 * Règle la main avec les cartes finales du croupier observées par la caméra.
 * Un joueur bust n'a pas besoin d'attendre que le croupier tire jusqu'à 17.
 */
function terminer(partie, cartesCroupier = partie.croupier) {
    if (partie.statut !== 'attente_croupier') {
        throw new Error('La partie ne peut pas être réglée avant la fin du tour du joueur.');
    }
    validerCartes(cartesCroupier, 'cartesCroupier');
    const main = partie.mains[0];
    const joueurNaturel = main.statut === 'blackjack';
    const joueurBust = main.statut === 'bust';
    // Il faut révéler la deuxième carte, sauf si le joueur a dépassé 21
    // ou s'il a un blackjack et que la carte visible du croupier (2 à 9) ne peut pas faire 21.
    const croupierIncomplet = cartesCroupier.length < 2;
    if (croupierIncomplet && !joueurBust
        && !(joueurNaturel && !croupierPeutAvoirBlackjack(cartesCroupier))) {
        throw new RangeError('La main finale du croupier doit contenir au moins deux cartes.');
    }
    const totalCroupier = valeurMain(cartesCroupier);
    // Un blackjack naturel se compare à la main initiale du croupier; les autres mains attendent 17.
    if (!joueurNaturel && !joueurBust && totalCroupier < CROUPIER_RESTE_A) {
        throw new Error('Le croupier doit tirer jusqu’à 17 avant le règlement.');
    }

    partie.croupier = [...cartesCroupier];
    const totalJoueur = valeurMain(main.cartes);
    const blackjackCroupier = estBlackjackNaturel(partie.croupier);

    if (main.statut === 'bust' || (blackjackCroupier && !joueurNaturel)) {
        main.resultat = 'perdu';
        main.gain = 0;
    } else if (joueurNaturel && blackjackCroupier) {
        main.resultat = 'egalite';
        main.gain = main.mise;
    } else if (joueurNaturel) {
        main.resultat = 'blackjack';
        main.gain = arrondir(main.mise * 2.5);
    } else if (totalCroupier > 21 || totalJoueur > totalCroupier) {
        main.resultat = 'gagne';
        main.gain = arrondir(main.mise * 2);
    } else if (totalJoueur === totalCroupier) {
        main.resultat = 'egalite';
        main.gain = main.mise;
    } else {
        main.resultat = 'perdu';
        main.gain = 0;
    }

    partie.statut = 'terminee';
    return partie;
}

module.exports = {
    creerPartie,
    jouer,
    terminer,
    actionsPossibles,
    croupierPeutAvoirBlackjack,
    valeurMain,
    arrondir,
};

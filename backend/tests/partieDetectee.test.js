const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    appliquerDetectionAction,
    demarrerManche,
    initialiserTourSiPret,
    jouerAction,
    mancheTerminee,
    resultatMain,
    terminerSurBlackjackCroupier,
    valeurMain,
} = require('../jeux/partieDetectee');

function salonAvecDeuxJoueurs() {
    return {
        status: 'waiting',
        dealer_hand: [],
        players: [
            { id_compte: 'joueur-1', seat_index: 0, bet: 10, hands: [], isTurn: false },
            { id_compte: 'joueur-2', seat_index: 1, bet: 20, hands: [], isTurn: false },
        ],
    };
}

test('demarrerManche initialise les mains et garde les mises', () => {
    const salon = salonAvecDeuxJoueurs();
    demarrerManche(salon);
    assert.equal(salon.status, 'playing');
    assert.equal(salon.dealComplete, false);
    assert.deepEqual(salon.players.map((player) => player.bet), [10, 20]);
    assert.deepEqual(salon.players.map((player) => player.hands), [[], []]);
});

test('initialiserTourSiPret attend les cartes initiales et saute un blackjack naturel', () => {
    const salon = salonAvecDeuxJoueurs();
    demarrerManche(salon);
    salon.dealer_hand = [{ rang: '10' }, { rang: '7' }];
    salon.players[0].hands = [{ mise: 10, cartes: [{ rang: 'A' }, { rang: 'K' }] }];
    salon.players[1].hands = [{ mise: 20, cartes: [{ rang: '9' }] }];

    assert.equal(initialiserTourSiPret(salon), false);
    salon.players[1].hands[0].cartes.push({ rang: '8' });

    assert.equal(initialiserTourSiPret(salon), true);
    assert.equal(salon.players[0].status, 'stand');
    assert.equal(salon.players[1].isTurn, true);
    assert.equal(salon.currentTurnSeat, 1);
});

test('le premier tour commence au plus petit siège quand aucun joueur naturel ne le saute', () => {
    const salon = salonAvecDeuxJoueurs();
    demarrerManche(salon);
    salon.dealer_hand = [{ rang: '10' }];
    salon.players[0].hands = [{ mise: 10, cartes: [{ rang: '10' }, { rang: '7' }] }];
    salon.players[1].hands = [{ mise: 20, cartes: [{ rang: '9' }, { rang: '8' }] }];

    assert.equal(initialiserTourSiPret(salon), true);
    assert.equal(salon.players[0].isTurn, true);
    assert.equal(salon.currentTurnSeat, 0);
});

test('un blackjack du croupier termine les tours et conserve les naturels pour l’égalité', () => {
    const salon = salonAvecDeuxJoueurs();
    demarrerManche(salon);
    salon.dealer_hand = [{ rang: 'A' }, { rang: 'K' }];
    salon.players[0].hands = [{ mise: 10, cartes: [{ rang: 'A' }, { rang: 'Q' }] }];
    salon.players[1].hands = [{ mise: 20, cartes: [{ rang: '9' }, { rang: '8' }] }];

    initialiserTourSiPret(salon);
    assert.equal(terminerSurBlackjackCroupier(salon), true);
    assert.equal(salon.players[0].hands[0].status, 'blackjack');
    assert.equal(salon.players[0].status, 'stand');
    assert.equal(salon.players[1].status, 'stand');
    assert.equal(salon.players.some((player) => player.isTurn), false);
    assert.equal(mancheTerminee(salon), true);
});

test('jouerAction : hit attend une carte détectée puis conserve le tour si la main reste ouverte', () => {
    const salon = salonAvecDeuxJoueurs();
    demarrerManche(salon);
    salon.dealComplete = true;
    salon.status = 'playing';
    salon.currentTurnSeat = 0;
    salon.players[0].isTurn = true;
    salon.players[0].hands = [{ mise: 10, cartes: [{ rang: '10' }, { rang: '5' }], status: 'playing' }];

    assert.deepEqual(jouerAction(salon, 'joueur-1', 'hit'), { ok: true, miseSupplementaire: 0 });
    salon.players[0].hands[0].cartes.push({ rang: '2' });
    assert.equal(appliquerDetectionAction(salon), true);
    assert.equal(salon.players[0].pendingAction, null);
    assert.equal(salon.players[0].status, 'playing');
    assert.equal(salon.players[0].isTurn, true);
});

test('jouerAction : stand passe le tour au prochain joueur', () => {
    const salon = salonAvecDeuxJoueurs();
    demarrerManche(salon);
    salon.dealComplete = true;
    salon.status = 'playing';
    salon.currentTurnSeat = 0;
    salon.players[0].isTurn = true;
    salon.players[0].hands = [{ mise: 10, cartes: [{ rang: '10' }, { rang: '7' }], status: 'playing' }];
    salon.players[1].status = 'playing';
    salon.players[1].hands = [{ mise: 20, cartes: [{ rang: '9' }, { rang: '8' }], status: 'playing' }];

    assert.equal(jouerAction(salon, 'joueur-1', 'stand').ok, true);
    assert.equal(salon.players[0].status, 'stand');
    assert.equal(salon.players[1].isTurn, true);
});

test('jouerAction : stand est permis même si le statut de la main est obsolète', () => {
    const salon = salonAvecDeuxJoueurs();
    demarrerManche(salon);
    salon.dealComplete = true;
    salon.status = 'playing';
    salon.currentTurnSeat = 0;
    salon.players[0].isTurn = true;
    salon.players[0].hands = [{ mise: 10, cartes: [{ rang: '10' }, { rang: '7' }], status: 'en_cours' }];
    salon.players[1].status = 'playing';
    salon.players[1].hands = [{ mise: 20, cartes: [{ rang: '9' }, { rang: '8' }], status: 'playing' }];

    assert.equal(jouerAction(salon, 'joueur-1', 'stand').ok, true);
    assert.equal(salon.players[0].hands[0].status, 'stand');
    assert.equal(salon.players[1].isTurn, true);
});

test('jouerAction : hit utilise le statut actif du joueur si le statut de sa main est obsolète', () => {
    const salon = salonAvecDeuxJoueurs();
    demarrerManche(salon);
    salon.dealComplete = true;
    salon.status = 'playing';
    salon.currentTurnSeat = 0;
    salon.players[0].isTurn = true;
    salon.players[0].hands = [{ mise: 10, cartes: [{ rang: '10' }, { rang: '7' }], status: 'en_cours' }];

    assert.deepEqual(jouerAction(salon, 'joueur-1', 'hit'), { ok: true, miseSupplementaire: 0 });
    assert.equal(salon.players[0].hands[0].status, 'playing');
    assert.equal(salon.players[0].pendingAction, 'hit');
});

test('jouerAction refuse hit si le joueur lui-même n’est plus en jeu', () => {
    const salon = salonAvecDeuxJoueurs();
    demarrerManche(salon);
    salon.dealComplete = true;
    salon.status = 'playing';
    salon.currentTurnSeat = 0;
    salon.players[0].isTurn = true;
    salon.players[0].status = 'stand';
    salon.players[0].hands = [{ mise: 10, cartes: [{ rang: '10' }, { rang: '7' }], status: 'playing' }];

    assert.equal(jouerAction(salon, 'joueur-1', 'hit').error, 'Votre main n’est plus en cours.');
});

test('jouerAction refuse un joueur qui n’a pas le tour', () => {
    const salon = salonAvecDeuxJoueurs();
    demarrerManche(salon);
    salon.dealComplete = true;
    salon.status = 'playing';
    salon.currentTurnSeat = 0;
    salon.players[0].isTurn = true;
    salon.players[0].hands = [{ mise: 10, cartes: [{ rang: '10' }, { rang: '7' }], status: 'playing' }];

    assert.equal(jouerAction(salon, 'joueur-2', 'hit').error, 'Ce n’est pas votre tour.');
});

test('jouerAction : double ajoute une mise et termine la main après la carte détectée', () => {
    const salon = salonAvecDeuxJoueurs();
    demarrerManche(salon);
    salon.dealComplete = true;
    salon.status = 'playing';
    salon.currentTurnSeat = 0;
    salon.players[0].isTurn = true;
    salon.players[0].hands = [{ mise: 10, cartes: [{ rang: '5' }, { rang: '6' }], status: 'playing' }];

    assert.deepEqual(jouerAction(salon, 'joueur-1', 'double'), { ok: true, miseSupplementaire: 10 });
    assert.equal(salon.players[0].bet, 20);
    salon.players[0].hands[0].cartes.push({ rang: '10' });
    appliquerDetectionAction(salon);
    assert.equal(salon.players[0].status, 'stand');
    assert.equal(salon.players[1].isTurn, true);
});

test('les valeurs gèrent les as, et la fin attend le croupier à 17 sauf si tous les joueurs ont bust', () => {
    const salon = salonAvecDeuxJoueurs();
    assert.equal(valeurMain([{ rang: 'A' }, { rang: '9' }, { rang: '5' }]), 15);
    salon.status = 'playing';
    salon.players[0].status = 'stand';
    salon.players[1].status = 'stand';
    salon.dealer_hand = [{ rang: '10' }, { rang: '6' }];
    assert.equal(mancheTerminee(salon), false);
    salon.dealer_hand.push({ rang: 'A' });
    assert.equal(mancheTerminee(salon), true);
    assert.equal(resultatMain({ cartes: [{ rang: 'A' }, { rang: 'K' }], naturel: true }, [{ rang: '9' }, { rang: '8' }]), 'blackjack');
    salon.players[0].status = 'bust';
    salon.players[1].status = 'bust';
    assert.equal(mancheTerminee(salon), true);
});

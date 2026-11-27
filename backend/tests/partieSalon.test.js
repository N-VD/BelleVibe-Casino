const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    appliquerActionJoueur,
    appliquerCartesDetectees,
    reglementPret,
    reglerMains,
} = require('../jeux/partieSalon');

const carte = (rang) => ({ rang });

function salonAvecJoueurs(nombre = 1) {
    return {
        status: 'playing',
        dealer_hand: [],
        currentTurnSeat: -1,
        players: Array.from({ length: nombre }, (_, seat_index) => ({
            id_compte: `joueur-${seat_index}`,
            seat_index,
            bet: 10,
            hands: [],
            status: 'waiting',
            pendingAction: null,
            isTurn: false,
        })),
    };
}

function detection(joueurs, croupier = ['K']) {
    return {
        croupier: { cartes: croupier, complete: true },
        joueurs: joueurs.map((cartes, index) => ({ id: index + 1, cartes, complete: true })),
    };
}

test('la détection complète distribue les mains et active le premier joueur', () => {
    const salon = salonAvecJoueurs(2);

    appliquerCartesDetectees(salon, detection([['10', '7'], ['9', '8']]));

    assert.equal(salon.currentTurnSeat, 0);
    assert.equal(salon.players[0].isTurn, true);
    assert.equal(salon.players[1].isTurn, false);
    assert.equal(salon.players[0].status, 'playing');
    assert.deepEqual(salon.players[1].hands[0].cartes, [carte('9'), carte('8')]);
});

test('une main caméra incomplète ne démarre pas le tour', () => {
    const salon = salonAvecJoueurs();
    const snapshot = detection([['10']]);
    snapshot.joueurs[0].complete = false;

    appliquerCartesDetectees(salon, snapshot);

    assert.deepEqual(salon.players[0].hands, []);
    assert.equal(salon.currentTurnSeat, -1);
});

test('la carte d’un joueur naturel est enregistrée sans lui donner le tour', () => {
    const salon = salonAvecJoueurs(2);

    appliquerCartesDetectees(salon, detection([['A', 'K'], ['9', '8']]));

    assert.equal(salon.players[0].status, 'blackjack');
    assert.equal(salon.players[0].isTurn, false);
    assert.equal(salon.currentTurnSeat, 1);
});

test('un blackjack naturel du croupier termine immédiatement les tours des joueurs', () => {
    const salon = salonAvecJoueurs();

    appliquerCartesDetectees(salon, detection([['10', '7']], ['A', 'K']));

    assert.equal(salon.currentTurnSeat, -1);
    assert.equal(salon.players[0].status, 'stand');
    assert.equal(reglementPret(salon), true);
    assert.equal(reglerMains(salon)[0].outcome, 'lose');
});

test('tirer attend une nouvelle carte détectée et refuse une carte non demandée', () => {
    const salon = salonAvecJoueurs();
    appliquerCartesDetectees(salon, detection([['10', '7']]));

    appliquerActionJoueur(salon, 'joueur-0', 'hit', 20);
    assert.equal(salon.players[0].pendingAction, 'hit');
    assert.deepEqual(salon.players[0].hands[0].cartes, [carte('10'), carte('7')]);

    appliquerCartesDetectees(salon, detection([['10', '7', '2']]));
    assert.equal(salon.players[0].pendingAction, null);
    assert.deepEqual(salon.players[0].hands[0].cartes, [carte('10'), carte('7'), carte('2')]);
    assert.equal(salon.players[0].status, 'playing');

    appliquerCartesDetectees(salon, detection([['10', '7', '2', '3']]));
    assert.equal(salon.players[0].hands[0].cartes.length, 3);
});

test('rester passe au prochain joueur et refuse les actions hors tour', () => {
    const salon = salonAvecJoueurs(2);
    appliquerCartesDetectees(salon, detection([['10', '7'], ['9', '8']]));

    appliquerActionJoueur(salon, 'joueur-0', 'stand', 0);

    assert.equal(salon.players[0].status, 'stand');
    assert.equal(salon.currentTurnSeat, 1);
    assert.throws(
        () => appliquerActionJoueur(salon, 'joueur-0', 'hit', 20),
        /Ce n’est pas votre tour/,
    );
});

test('doubler exige le financement et ajoute une carte puis termine le tour', () => {
    const salon = salonAvecJoueurs();
    appliquerCartesDetectees(salon, detection([['5', '6']]));

    assert.throws(
        () => appliquerActionJoueur(salon, 'joueur-0', 'double', 9.99),
        /double est impossible/,
    );
    const action = appliquerActionJoueur(salon, 'joueur-0', 'double', 10);
    assert.equal(action.coutSupplementaire, 10);

    appliquerCartesDetectees(salon, detection([['5', '6', '10']]));
    assert.equal(salon.players[0].status, 'stand');
    assert.equal(salon.players[0].bet, 20);
    assert.equal(salon.players[0].hands[0].mise, 20);
    assert.equal(salon.players[0].hands[0].double, true);
});

test('le règlement attend la main du croupier et prépare les gains enregistrés', () => {
    const salon = salonAvecJoueurs();
    appliquerCartesDetectees(salon, detection([['10', '8']]));
    appliquerActionJoueur(salon, 'joueur-0', 'stand', 0);

    assert.equal(reglementPret(salon), false);
    salon.dealer_hand = [carte('10'), carte('7')];
    assert.equal(reglementPret(salon), true);

    const historiques = reglerMains(salon);
    assert.equal(historiques[0].outcome, 'win');
    assert.equal(historiques[0].payout, 20);
    assert.equal(salon.players[0].status, 'finished');
    assert.equal(salon.currentTurnSeat, -1);
});

test('un blackjack est réglé sans 2e carte si la carte du croupier ne peut pas faire 21', () => {
    const salon = salonAvecJoueurs();
    appliquerCartesDetectees(salon, detection([['A', 'K']], ['7']));

    assert.equal(salon.players[0].status, 'blackjack');
    assert.equal(reglementPret(salon), true);
    const historiques = reglerMains(salon);
    assert.equal(historiques[0].outcome, 'blackjack');
    assert.equal(historiques[0].payout, 25);
});

test('un blackjack attend la 2e carte si le croupier montre un as ou un 10', () => {
    for (const visible of ['A', '10', 'K']) {
        const salon = salonAvecJoueurs();
        appliquerCartesDetectees(salon, detection([['A', 'K']], [visible]));

        assert.equal(reglementPret(salon), false, `croupier ${visible}`);
    }
});

test('un blackjack et une main stand attendent toujours le croupier', () => {
    const salon = salonAvecJoueurs(2);
    appliquerCartesDetectees(salon, detection([['A', 'K'], ['10', '8']], ['7']));
    appliquerActionJoueur(salon, 'joueur-1', 'stand', 0);

    assert.equal(reglementPret(salon), false);
});

test('toutes les mains bust peuvent être réglées sans attendre le croupier', () => {
    const salon = salonAvecJoueurs();
    appliquerCartesDetectees(salon, detection([['10', '8']]));
    appliquerActionJoueur(salon, 'joueur-0', 'hit', 20);
    appliquerCartesDetectees(salon, detection([['10', '8', '5']]));

    assert.equal(salon.players[0].status, 'bust');
    assert.equal(reglementPret(salon), true);
    assert.equal(reglerMains(salon)[0].payout, 0);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    actionsPossibles,
    creerPartie,
    jouer,
    terminer,
    valeurMain,
} = require('../jeux/blackjack');

const carte = (rang) => ({ rang });

test('valeurMain convertit les as de 11 à 1 lorsque nécessaire', () => {
    assert.equal(valeurMain([carte('A'), carte('9')]), 20);
    assert.equal(valeurMain([carte('A'), carte('9'), carte('5')]), 15);
});

test('les actions proposées incluent le double financé, jamais le split', () => {
    const partie = creerPartie({
        mise: 10,
        cartesJoueur: [carte('8'), carte('3')],
        cartesCroupier: [carte('K')],
    });

    assert.deepEqual(actionsPossibles(partie, 10), ['hit', 'stand', 'double']);
    assert.deepEqual(actionsPossibles(partie, 9.99), ['hit', 'stand']);
    assert.throws(() => jouer(partie, 'split'), /Action impossible/);
});

test('tirer utilise la carte détectée et termine le tour sur 21', () => {
    const partie = creerPartie({
        mise: 10,
        cartesJoueur: [carte('10'), carte('6')],
        cartesCroupier: [carte('9')],
    });

    jouer(partie, 'hit', { carte: carte('5'), solde: 10 });

    assert.equal(partie.mains[0].statut, 'stand');
    assert.equal(partie.statut, 'attente_croupier');
    assert.deepEqual(partie.mains[0].cartes, [carte('10'), carte('6'), carte('5')]);
    assert.deepEqual(actionsPossibles(partie, 10), []);
    assert.deepEqual(partie.croupier, [carte('9')]);
});

test('rester attend que la main finale du croupier soit détectée avant le règlement', () => {
    const partie = creerPartie({
        mise: 10,
        cartesJoueur: [carte('10'), carte('8')],
        cartesCroupier: [carte('10')],
    });
    jouer(partie, 'stand');

    assert.throws(() => terminer(partie, [carte('10'), carte('4')]), /doit tirer jusqu’à 17/);
    terminer(partie, [carte('10'), carte('7')]);
    assert.equal(partie.mains[0].resultat, 'gagne');
    assert.equal(partie.mains[0].gain, 20);
});

test('doubler double la mise et termine après une seule carte détectée', () => {
    const partie = creerPartie({
        mise: 10,
        cartesJoueur: [carte('5'), carte('6')],
        cartesCroupier: [carte('K')],
    });
    jouer(partie, 'double', { carte: carte('10'), solde: 10 });

    assert.equal(partie.mains[0].mise, 20);
    assert.equal(partie.mains[0].double, true);
    assert.equal(partie.mains[0].statut, 'stand');
    assert.equal(partie.statut, 'attente_croupier');
});

test('le blackjack naturel paie 3 pour 2 et une égalité rembourse la mise', () => {
    const naturel = creerPartie({
        mise: 10,
        cartesJoueur: [carte('A'), carte('K')],
        cartesCroupier: [carte('10')],
    });
    assert.deepEqual(actionsPossibles(naturel, 100), []);
    terminer(naturel, [carte('10'), carte('7')]);
    assert.equal(naturel.mains[0].resultat, 'blackjack');
    assert.equal(naturel.mains[0].gain, 25);

    const egalite = creerPartie({
        mise: 10,
        cartesJoueur: [carte('10'), carte('8')],
        cartesCroupier: [carte('10')],
    });
    jouer(egalite, 'stand');
    terminer(egalite, [carte('10'), carte('8')]);
    assert.equal(egalite.mains[0].resultat, 'egalite');
    assert.equal(egalite.mains[0].gain, 10);
});

test('une main bust est perdue sans attendre que le croupier tire', () => {
    const partie = creerPartie({
        mise: 10,
        cartesJoueur: [carte('10'), carte('8')],
        cartesCroupier: [carte('6')],
    });
    jouer(partie, 'hit', { carte: carte('5'), solde: 0 });
    terminer(partie);

    assert.equal(partie.mains[0].resultat, 'perdu');
    assert.equal(partie.mains[0].gain, 0);
});

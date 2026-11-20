const { test } = require('node:test');
const assert = require('node:assert/strict');
const Salon = require('../models/salon');
const Compte = require('../models/compte');
const Transaction = require('../models/transaction');
const Hand = require('../models/hand');
const { tenterReglementManche } = require('../jeux/reglementManche');

function salonInitial() {
    return {
        _id: 'salon-test',
        status: 'playing',
        updated_at: new Date(1),
        dealer_hand: [{ rang: '10' }, { rang: '7' }],
        currentTurnSeat: -1,
        players: [{
            id_compte: 'joueur-test',
            seat_index: 0,
            bet: 10,
            hands: [{
                cartes: [{ rang: '10' }, { rang: '8' }],
                mise: 10,
                status: 'stand',
                double: false,
            }],
            status: 'stand',
            pendingAction: null,
            isTurn: false,
        }],
    };
}

function copierSalon(salon) {
    return {
        ...salon,
        updated_at: new Date(salon.updated_at),
        dealer_hand: salon.dealer_hand.map((carte) => ({ ...carte })),
        players: salon.players.map((player) => ({
            ...player,
            hands: player.hands.map((main) => ({
                ...main,
                cartes: main.cartes.map((carte) => ({ ...carte })),
            })),
        })),
    };
}

function installerFauxModeles({ faireEchouerHistorique = false } = {}) {
    const originaux = {
        salonFindById: Salon.findById,
        salonFindOneAndUpdate: Salon.findOneAndUpdate,
        compteFindOneAndUpdate: Compte.findOneAndUpdate,
        compteFindByIdAndUpdate: Compte.findByIdAndUpdate,
        transactionCreate: Transaction.create,
        transactionFindByIdAndDelete: Transaction.findByIdAndDelete,
        handCreate: Hand.create,
        handFindByIdAndDelete: Hand.findByIdAndDelete,
    };
    const base = salonInitial();
    const etat = { salon: base, solde: 100, transactions: [], mains: [] };

    Salon.findById = async () => copierSalon(etat.salon);
    Salon.findOneAndUpdate = async (filtre, update) => {
        if (etat.salon._id !== filtre._id
            || etat.salon.status !== filtre.status
            || etat.salon.updated_at.getTime() !== filtre.updated_at.getTime()) return null;
        Object.assign(etat.salon, update.$set);
        return copierSalon(etat.salon);
    };
    Compte.findOneAndUpdate = async (_filtre, update) => {
        etat.solde += update.$inc.montant;
        return { montant: etat.solde };
    };
    Compte.findByIdAndUpdate = async (_id, update) => {
        etat.solde += update.$inc.montant;
        return { montant: etat.solde };
    };
    Transaction.create = async (transaction) => {
        const doc = { ...transaction, _id: `transaction-${etat.transactions.length}` };
        etat.transactions.push(doc);
        return doc;
    };
    Transaction.findByIdAndDelete = async (id) => {
        etat.transactions = etat.transactions.filter((transaction) => transaction._id !== id);
    };
    Hand.create = async (main) => {
        if (faireEchouerHistorique) throw new Error('Échec simulé de l’historique.');
        const doc = { ...main, _id: 'historique-test' };
        etat.mains.push(doc);
        return doc;
    };
    Hand.findByIdAndDelete = async (id) => {
        etat.mains = etat.mains.filter((main) => main._id !== id);
    };

    return {
        etat,
        restaurer() {
            Salon.findById = originaux.salonFindById;
            Salon.findOneAndUpdate = originaux.salonFindOneAndUpdate;
            Compte.findOneAndUpdate = originaux.compteFindOneAndUpdate;
            Compte.findByIdAndUpdate = originaux.compteFindByIdAndUpdate;
            Transaction.create = originaux.transactionCreate;
            Transaction.findByIdAndDelete = originaux.transactionFindByIdAndDelete;
            Hand.create = originaux.handCreate;
            Hand.findByIdAndDelete = originaux.handFindByIdAndDelete;
        },
    };
}

test('le règlement crédite et historise une seule fois', async () => {
    const faux = installerFauxModeles();
    let notifications = 0;
    try {
        assert.equal(await tenterReglementManche('salon-test', async () => notifications++), true);
        assert.equal(faux.etat.salon.status, 'finished');
        assert.equal(faux.etat.solde, 120);
        assert.equal(faux.etat.transactions.length, 1);
        assert.equal(faux.etat.mains[0].players[0].payout, 20);
        assert.equal(notifications, 1);
        assert.equal(await tenterReglementManche('salon-test'), false);
        assert.equal(faux.etat.solde, 120);
    } finally {
        faux.restaurer();
    }
});

test('un échec d’historique annule le crédit et rouvre la manche', async () => {
    const faux = installerFauxModeles({ faireEchouerHistorique: true });
    try {
        await assert.rejects(tenterReglementManche('salon-test'), /Échec simulé de l’historique/);
        assert.equal(faux.etat.salon.status, 'playing');
        assert.equal(faux.etat.solde, 100);
        assert.equal(faux.etat.transactions.length, 0);
    } finally {
        faux.restaurer();
    }
});

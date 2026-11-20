const { test } = require('node:test');
const assert = require('node:assert/strict');
const Salon = require('../models/salon');
const { retirerJoueur, annulerDepart } = require('../sockets/socketServer');

test('si le règlement prend le verrou, le retrait attend sans écraser son état', async () => {
    const originaux = {
        findById: Salon.findById,
        findOneAndUpdate: Salon.findOneAndUpdate,
    };
    const date = new Date(1000);
    const salonEnCours = {
        _id: 'salon-test',
        status: 'playing',
        updated_at: date,
        currentTurnSeat: 0,
        players: [{
            id_compte: 'joueur-test',
            seat_index: 0,
            bet: 10,
            status: 'playing',
            isTurn: true,
        }],
    };
    const salonEnReglement = { ...salonEnCours, status: 'settling' };
    let lectures = 0;
    let misesAJour = 0;
    let filtreMiseAJour;

    Salon.findById = async () => lectures++ === 0 ? salonEnCours : salonEnReglement;
    Salon.findOneAndUpdate = async (filtre) => {
        misesAJour++;
        filtreMiseAJour = filtre;
        return null;
    };

    try {
        await retirerJoueur('salon-test', 'joueur-test');
        assert.equal(misesAJour, 1);
        assert.equal(filtreMiseAJour.status, 'playing');
        assert.equal(filtreMiseAJour.updated_at, date);
        assert.equal(lectures, 2);
        annulerDepart('salon-test', 'joueur-test');
    } finally {
        annulerDepart('salon-test', 'joueur-test');
        Salon.findById = originaux.findById;
        Salon.findOneAndUpdate = originaux.findOneAndUpdate;
    }
});

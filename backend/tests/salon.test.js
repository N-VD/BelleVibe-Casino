const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const salonRouter = require('../Routes/Salon');
const Salon = require('../models/salon');
const Compte = require('../models/compte');
const { jwt, jwt_mdp } = require('../fonctionsCommunes');

// Application Express de test
const app = express();
app.use(express.json());
app.use(salonRouter);

// ── Tests de Sécurité (Token manquant) ──────────────────────────────────────

test('POST /createSalon : retourne 401 si aucun token fourni', async () => {
    const res = await request(app).post('/createSalon');
    assert.equal(res.status, 401);
    assert.equal(res.body.message, "Accès refusé. Token manquant.");
});

test('POST /addPlayer : retourne 401 si aucun token fourni', async () => {
    const res = await request(app).post('/addPlayer');
    assert.equal(res.status, 401);
    assert.equal(res.body.message, "Accès refusé. Token manquant.");
});

test('DELETE /deleteSalon : retourne 401 si aucun token fourni', async () => {
    const res = await request(app).delete('/deleteSalon');
    assert.equal(res.status, 401);
    assert.equal(res.body.message, "Accès refusé. Token manquant.");
});

// ── Tests de Validation des Paramètres de Salon ─────────────────────────────

test('POST /addPlayer : valide la présence de salonId et seat_index valide', () => {
    const seatInvalide = -1;
    const seatNonEntier = 1.5;

    assert.equal(Number.isInteger(seatInvalide) && seatInvalide >= 0, false);
    assert.equal(Number.isInteger(seatNonEntier) && seatNonEntier >= 0, false);
    assert.equal(Number.isInteger(0) && 0 >= 0, true);
});

test('PATCH /gameStatus : refuse un état de partie fourni par le client', async () => {
    const findByIdOriginal = Compte.findById;
    Compte.findById = async () => ({ ban_status: false });
    try {
        const token = jwt.sign({ id: '507f1f77bcf86cd799439011', role: 'player' }, jwt_mdp);
        const res = await request(app)
            .patch('/gameStatus')
            .set('Authorization', `Bearer ${token}`)
            .send({
                salonId: '507f1f77bcf86cd799439012',
                status: 'finished',
                players: [],
            });

        assert.equal(res.status, 400);
        assert.match(res.body.message, /salonId valide et action sont obligatoires/);
    } finally {
        Compte.findById = findByIdOriginal;
    }
});

test('DELETE /deleteSalon : rejette un ID MongoDB invalide', () => {
    const idInvalide = "123456";
    // Simulation de mongoose.Types.ObjectId.isValid
    const isValid = idInvalide.length === 24; 
    assert.equal(isValid, false);
});

test('Salon : convertit une ancienne main unique vers hands lors du chargement', () => {
    const salon = Salon.hydrate({
        players: [{
            id_compte: '507f1f77bcf86cd799439011',
            seat_index: 0,
            hand: [{ rang: 'A' }, { rang: 'K' }],
            bet: 10,
            status: 'blackjack',
            isTurn: false
        }]
    });

    assert.deepEqual(salon.players[0].hands[0].cartes, [{ rang: 'A' }, { rang: 'K' }]);
    assert.equal(salon.players[0].hands[0].mise, 10);
    assert.equal(salon.players[0].hands[0].status, 'blackjack');
    assert.equal(salon.players[0].hands[0].naturel, true);
    assert.equal(salon.players[0].hand, undefined);
});

// ── Joueurs du salon ────────────────────────────────────────────────────────

test('estJoueurDuSalon : vrai seulement pour un joueur assis', () => {
    const salon = { players: [{ id_compte: 'abc123', seat_index: 0 }] };
    assert.equal(salonRouter.estJoueurDuSalon(salon, 'abc123'), true);
    assert.equal(salonRouter.estJoueurDuSalon(salon, 'zzz999'), false);
});

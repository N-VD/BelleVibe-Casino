const { test } = require('node:test');
const assert = require('node:assert/strict');
const { versCartes } = require('../jeux/mainsDetectees');

test('versCartes transforme les rangs reconnus en cartes', () => {
    assert.deepEqual(versCartes(['K', '7']), [{ rang: 'K' }, { rang: '7' }]);
    assert.deepEqual(versCartes(undefined), []);
});

test('versCartes rejette les rangs non reconnus', () => {
    assert.throws(() => versCartes(['joker']), /rangs de carte valides/);
});

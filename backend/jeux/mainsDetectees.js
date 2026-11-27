const RANGS = new Set(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);

/** Entrée : rangs détectés (["K", "7"]); sortie : cartes du salon ([{ rang: "K" }, { rang: "7" }]). */
function versCartes(rangs) {
    if (rangs == null) return [];
    if (!Array.isArray(rangs) || rangs.some((rang) => !RANGS.has(rang))) {
        throw new TypeError('Les rangs détectés doivent être des rangs de carte valides.');
    }
    return rangs.map((rang) => ({ rang }));
}

module.exports = { versCartes };
const Salon = require('../models/salon');
const Compte = require('../models/compte');
const Transaction = require('../models/transaction');
const Hand = require('../models/hand');
const { reglementPret, reglerMains } = require('./partieSalon');

/** Produit une date strictement ultérieure pour les mises à jour comparées par version temporelle. */
function prochaineDate(date) {
    const precedent = date ? new Date(date).getTime() : 0;
    return new Date(Math.max(Date.now(), precedent + 1));
}

/** Règle une manche prête une seule fois, crédite les gagnants et conserve son historique. */
async function tenterReglementManche(salonId, notifier = async () => {}) {
    const salon = await Salon.findById(salonId);
    if (!salon || salon.status !== 'playing' || !reglementPret(salon)) return false;

    const debutReglement = prochaineDate(salon.updated_at);
    const salonVerrouille = await Salon.findOneAndUpdate(
        { _id: salonId, status: 'playing', updated_at: salon.updated_at },
        { $set: { status: 'settling', updated_at: debutReglement } },
        { new: true },
    );
    if (!salonVerrouille) return false;

    const mouvements = [];
    let historique = null;
    let salonTermine = null;
    try {
        const joueursHistorique = reglerMains(salonVerrouille);
        for (const joueur of joueursHistorique) {
            if (joueur.payout <= 0) continue;

            const compte = await Compte.findOneAndUpdate(
                { _id: joueur.id_compte },
                { $inc: { montant: joueur.payout } },
                { new: true },
            );
            if (!compte) throw new Error(`Compte introuvable pour le règlement : ${joueur.id_compte}`);

            const mouvement = { id_compte: joueur.id_compte, montant: joueur.payout, transactionId: null };
            mouvements.push(mouvement);
            const transaction = await Transaction.create({
                id_compte: joueur.id_compte,
                desc: 'Gain blackjack en salon',
                montant: joueur.payout,
            });
            mouvement.transactionId = transaction._id;
        }

        historique = await Hand.create({
            id_table: salonVerrouille._id,
            dealer_hand: salonVerrouille.dealer_hand,
            players: joueursHistorique,
        });

        const dateTerminee = prochaineDate(debutReglement);
        salonTermine = await Salon.findOneAndUpdate(
            { _id: salonId, status: 'settling', updated_at: debutReglement },
            {
                $set: {
                    status: 'finished',
                    players: salonVerrouille.players,
                    currentTurnSeat: -1,
                    updated_at: dateTerminee,
                },
            },
            { new: true, runValidators: true },
        );
        if (!salonTermine) throw new Error('Le salon n’a pas pu être finalisé après le règlement.');
    } catch (error) {
        for (const mouvement of mouvements.reverse()) {
            try {
                await Compte.findByIdAndUpdate(mouvement.id_compte, {
                    $inc: { montant: -mouvement.montant },
                });
                if (mouvement.transactionId) {
                    await Transaction.findByIdAndDelete(mouvement.transactionId);
                }
            } catch (erreurAnnulation) {
                console.error('Échec de l’annulation du paiement blackjack :', erreurAnnulation);
            }
        }
        if (historique) {
            try {
                await Hand.findByIdAndDelete(historique._id);
            } catch (erreurHistorique) {
                console.error('Échec de la suppression de l’historique blackjack :', erreurHistorique);
            }
        }

        try {
            await Salon.findOneAndUpdate(
                { _id: salonId, status: 'settling', updated_at: debutReglement },
                { $set: { status: 'playing', updated_at: prochaineDate(debutReglement) } },
            );
        } catch (erreurDeverrouillage) {
            console.error('Échec du déverrouillage du salon après une erreur de règlement :', erreurDeverrouillage);
        }
        throw error;
    }

    try {
        await notifier(salonTermine);
    } catch (erreurDiffusion) {
        console.error('Échec de diffusion du règlement blackjack :', erreurDiffusion);
    }
    return true;
}

module.exports = { tenterReglementManche };

const express = require('express');
const mongoose = require('mongoose');
const { authentifier, authentifierOptionnel } = require('../fonctionsCommunes');
const Salon = require('../models/salon');
const Compte = require('../models/compte');
const Transaction = require('../models/transaction');
const { notifierSalonFerme, notifierSalonMisAJour } = require('../sockets/socketServer');
const { appliquerActionJoueur } = require('../jeux/partieSalon');
const { tenterReglementManche } = require('../jeux/reglementManche');
//const { verifierTimeoutEtLimite } = require('./Fontion/timeOut');
const router = express.Router();


// est un joueur

function estJoueurDuSalon(salon, idCompte) {
    return salon.players.some((player) => player.id_compte.toString() === idCompte.toString());
}

// Routes

// Routes Pour crée un Salon
router.post('/createSalon', authentifier, async (req, res) => {
    const role = req.user?.role?.toLowerCase();
    // Seul un compte avec un role dealer (ou admin) peut crée des salons
    if (role !== 'dealer' && role !== 'admin') {
        return res.status(403).json({ message: "Accès refusé. Seul un dealer peut créer un salon." });
    }

    try {
        // Aucune main n'existe lors de la création et aucun joueur n'est encore connecté
        const salon = await Salon.create({
            created_by: req.user.id,
            status: 'waiting',
            dealer_hand: [],
            deck: [],
            players: [],
            currentTurnSeat: -1
        });

        return res.status(201).json({ message: 'Salon créé', salon })
    } catch (error) {
        return res.status(500).json({ message: 'Erreur lors de la création du salon' });
    }
});

// Accessible sans compte : un invité voit la liste pour aller regarder une table (rôle spectateur dans le socket)
router.get('/salons', authentifierOptionnel, async (req, res) => {
    try {
        const role = req.user?.role?.toLowerCase();
        const filtre = role === 'dealer' || role === 'admin'
            ? { status: { $in: ['waiting', 'playing', 'settling', 'finished'] } }
            : { status: { $in: ['waiting', 'playing', 'settling'] } };
        // Un invité n'a pas besoin des id de comptes (savoir s'il est assis, qui a créé le salon)
        const champs = req.user
            ? '_id created_by status players.id_compte players.seat_index created_at'
            : '_id status players.seat_index created_at';
        const salons = await Salon.find(filtre)
            .select(champs)
            .sort({ created_at: 1 })
            .lean();
        return res.status(200).json({ salons });
    } catch (error) {
        return res.status(500).json({ message: 'Erreur lors du chargement des salons.' });
    }
});

//Route pour que un joueur puis rejoindre un salon il doit avoir le role player
router.post('/addPlayer', authentifier, async (req, res) => {

    const { salonId, seat_index } = req.body;
    const role = req.user?.role?.toLowerCase();

    // Les compte avec le rôle de dealer ne peuvent pas participer au jeux
    if (role !== 'player') {
        return res.status(403).json({ message: "Accès refusé. Seul un joueur peut rejoindre un salon." });
    }

    // S'assurer que le salon existe belle et bien
    if (!salonId ||!mongoose.isValidObjectId(salonId)|| !Number.isInteger(seat_index) || seat_index < 0) {
        return res.status(400).json({ message: 'salonId et seat_index sont obligatoires.' });
    }

    try {
        const salon = await Salon.findById(salonId);
        // Le salon doit exister pour rejoindre
        if (!salon) {
            return res.status(404).json({ message: 'Salon non trouvé.' });
        }

        const joueurExistant = salon.players.find((player) => player.id_compte.toString() === req.user.id.toString());
        if (joueurExistant) {
            salon.players.sort((a, b) => a.seat_index - b.seat_index);
            return res.status(200).json({ message: 'Joueur reconnecté au salon.', salon });
        }

        // Une table peut accueillir au maximum six joueurs
        if (salon.players.length >= 6) {
            return res.status(409).json({ message: 'Ce salon est complet.' });
        }

        // Un joueur ne peut pas rejoindre un partie au milieur d'une manche
        if (salon.status !== 'waiting') {
            return res.status(409).json({ message: 'Ce salon n’accepte pas de joueurs pour le moment.' });
        }

        // Un joueur ne peut pas rejoinde un siege déja occupé
        if (salon.players.some((player) => player.seat_index === seat_index)) {
            return res.status(409).json({ message: 'Cette place est déjà occupée.' });
        }

        // Quand le joueur arriver il attend de reçevoir ses cartes
        salon.players.push({
            id_compte: req.user.id,
            seat_index,
            hands: [],
            bet: 0,
            status: 'waiting',
            isTurn: false
        });
        salon.players.sort((a, b) => a.seat_index - b.seat_index);
        salon.updated_at = new Date();
        await salon.save();

        return res.status(201).json({ message: 'Joueur ajouté au salon.', salon });
    } catch (error) {
        return res.status(500).json({ message: "Erreur lors de l'ajout du joueur." });
    }
});

// Le client envoie une action; l'état du jeu et les cartes restent sous le contrôle du serveur.
router.patch('/gameStatus', authentifier, async (req, res) => {
    const body = req.body ?? {};
    const { salonId, action } = body;
    if (!salonId || !mongoose.isValidObjectId(salonId)
        || Object.keys(body).some((cle) => !['salonId', 'action'].includes(cle))) {
        return res.status(400).json({ message: 'salonId valide et action sont obligatoires.' });
    }
    if (req.user?.role?.toLowerCase() !== 'player') {
        return res.status(403).json({ message: 'Seul un joueur peut agir sur sa main.' });
    }

    let mouvement = null;
    try {
        const salon = await Salon.findById(salonId);
        if (!salon) return res.status(404).json({ message: 'Salon non trouvé.' });
        const compte = await Compte.findById(req.user.id).select('montant');
        if (!compte) return res.status(404).json({ message: 'Compte introuvable.' });

        const { coutSupplementaire, player } = appliquerActionJoueur(
            salon,
            req.user.id,
            action,
            compte.montant,
        );

        let soldeApresAction = compte.montant;
        if (coutSupplementaire > 0) {
            const compteDebite = await Compte.findOneAndUpdate(
                { _id: req.user.id, montant: { $gte: coutSupplementaire } },
                { $inc: { montant: -coutSupplementaire } },
                { new: true },
            );
            if (!compteDebite) return res.status(400).json({ message: 'Solde insuffisant pour doubler.' });
            soldeApresAction = compteDebite.montant;
            mouvement = { id_compte: req.user.id, montant: coutSupplementaire, transactionId: null };
            const transaction = await Transaction.create({
                id_compte: req.user.id,
                desc: 'Double blackjack en salon',
                montant: -coutSupplementaire,
            });
            mouvement.transactionId = transaction._id;
        }

        const dateMiseAJour = new Date(Math.max(Date.now(), new Date(salon.updated_at).getTime() + 1));
        const salonMisAJour = await Salon.findOneAndUpdate(
            {
                _id: salonId,
                status: 'playing',
                currentTurnSeat: player.seat_index,
                updated_at: salon.updated_at,
                players: {
                    $elemMatch: {
                        id_compte: req.user.id,
                        seat_index: player.seat_index,
                        status: 'playing',
                        isTurn: true,
                        pendingAction: null,
                    },
                },
            },
            {
                $set: {
                    players: salon.players,
                    currentTurnSeat: salon.currentTurnSeat,
                    updated_at: dateMiseAJour,
                },
            },
            { new: true, runValidators: true },
        );
        if (!salonMisAJour) {
            throw Object.assign(new Error('La table a changé; rechargez son état avant de réessayer.'), { status: 409 });
        }

        mouvement = null;
        try {
            await notifierSalonMisAJour(salonMisAJour);
        } catch (erreurDiffusion) {
            console.error('Échec de diffusion de l’action blackjack :', erreurDiffusion);
        }
        try {
            await tenterReglementManche(salonId, notifierSalonMisAJour);
        } catch (erreurReglement) {
            console.error('Échec du règlement après action blackjack :', erreurReglement);
        }

        let salonFinal = salonMisAJour;
        let soldeFinal = soldeApresAction;
        try {
            const [salonRecharge, compteRecharge] = await Promise.all([
                Salon.findById(salonId),
                Compte.findById(req.user.id).select('montant'),
            ]);
            if (salonRecharge) salonFinal = salonRecharge;
            if (compteRecharge) soldeFinal = compteRecharge.montant;
        } catch (erreurRechargement) {
            console.error('Échec du rechargement de l’état après action blackjack :', erreurRechargement);
        }
        return res.status(200).json({
            ok: true,
            solde: soldeFinal,
            gameStatus: salonFinal ? {
                status: salonFinal.status,
                dealer_hand: salonFinal.dealer_hand,
                players: [...salonFinal.players].sort((a, b) => a.seat_index - b.seat_index),
                currentTurnSeat: salonFinal.currentTurnSeat,
            } : null,
        });
    } catch (error) {
        if (mouvement) {
            try {
                await Compte.findByIdAndUpdate(mouvement.id_compte, {
                    $inc: { montant: mouvement.montant },
                });
                if (mouvement.transactionId) await Transaction.findByIdAndDelete(mouvement.transactionId);
            } catch (erreurAnnulation) {
                console.error('Échec de l’annulation du débit du double :', erreurAnnulation);
            }
        }
        if (error.status) return res.status(error.status).json({ message: error.message });
        console.error('ERREUR ROUTE GAMESTATUS :', error);
        return res.status(500).json({ message: 'Erreur lors de l’action blackjack.' });
    }
});

router.delete('/deleteSalon', authentifier, async (req, res) => {
    const { salonId } = req.body;
    const role = req.user?.role?.toLowerCase();

    // Seul un dealer a le droit de fermé un salon
    if (role !== 'dealer' && role !== 'admin') {
        return res.status(403).json({ message: "Accès refusé. Seul un dealer peut supprimer un salon." });
    }

    if (!salonId || !mongoose.Types.ObjectId.isValid(salonId)) {
        return res.status(400).json({ message: 'salonId est obligatoire et doit être valide.' });
    }

    try {
        const salon = await Salon.findById(salonId);

        if (!salon) {
            return res.status(404).json({ message: 'Salon non trouvé.' });
        }

        const estAdmin = role === 'admin';
        const estCreateur = salon.created_by?.toString() === req.user.id.toString();
        if (!estAdmin && !estCreateur) {
            return res.status(403).json({ message: 'Vous ne pouvez fermer que les salons que vous avez créés.' });
        }

        const salonSupprime = await Salon.findOneAndDelete({
            _id: salonId,
            status: { $nin: ['playing', 'settling'] },
        });
        if (!salonSupprime) {
            return res.status(409).json({ message: 'Le salon ne peut pas être fermé pendant une partie.' });
        }
        notifierSalonFerme(salonId); // les connexions encore à la table sont renvoyées au lobby

        return res.status(200).json({ message: 'Salon supprimé.', salon: salonSupprime });
    } catch (error) {
        console.error('ERREUR ROUTE DELETESALON :', error);
        return res.status(500).json({ message: 'Erreur lors de la suppression du salon.' });
    }
});

module.exports = router;
module.exports.estJoueurDuSalon = estJoueurDuSalon;
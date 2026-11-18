import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { connecterSocket } from "../services/socket.js";
import "./Blackjack.css";
import Chat from "./Chat.jsx";
import { lireUtilisateur, totalMain } from "./reglesBlackjack/outils.js";

const FPS_ENVOI = 10;
const QUALITE_JPEG = 0.7;
const DELAI_IMAGE_PERDUE = 3000; // ms sans image avant d'afficher « caméra coupée »
const LIBELLES_RESULTATS = {
	blackjack: "Blackjack",
	gagne: "Gagné",
	egalite: "Égalité",
	perdu: "Perdu",
};

/** Entrée : message d'erreur de getUserMedia; sortie : texte lisible pour le dealer. */
function messageErreurCamera(erreur) {
	if (erreur?.name === "NotAllowedError") return "Accès à la caméra refusé. Autorisez-la dans le navigateur.";
	if (erreur?.name === "NotFoundError") return "Aucune caméra détectée sur cet ordinateur.";
	if (erreur?.name === "NotReadableError") return "La caméra est déjà utilisée par un autre programme.";
	return "Impossible d'ouvrir la caméra.";
}

/**
 * Entrées : actif (ce client filme), socket, ref du <video> d'aperçu et setter du statut; sortie : aucune.
 * Filme la webcam du dealer et envoie une image JPEG au backend FPS_ENVOI fois par seconde.
 */
function useCaptureCamera(actif, socket, videoRef, setStatut) {
	useEffect(() => {
		if (!actif || !socket) return undefined;
		// getUserMedia n'existe que sur localhost ou en HTTPS
		if (!navigator.mediaDevices?.getUserMedia) {
			setStatut({ type: "erreur", texte: "La caméra exige localhost ou HTTPS." });
			return undefined;
		}

		let flux = null;
		let minuterie = null;
		let annule = false; // le composant peut être démonté avant que la caméra réponde
		let enCours = false;
		const canvas = document.createElement("canvas");

		(async () => {
			try {
				setStatut({ type: "info", texte: "Ouverture de la caméra..." });
				flux = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
				if (annule) return flux.getTracks().forEach((piste) => piste.stop());

				const video = videoRef.current;
				video.srcObject = flux;
				await video.play();
				canvas.width = video.videoWidth;
				canvas.height = video.videoHeight;
				setStatut({ type: "succes", texte: "Caméra en direct" });

				minuterie = window.setInterval(() => {
					if (enCours || !socket.connected) return; // l'image précédente n'est pas encore partie : on saute
					enCours = true;
					canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
					canvas.toBlob(async (blob) => {
						if (blob && !annule) socket.emit("frame", await blob.arrayBuffer());
						enCours = false;
					}, "image/jpeg", QUALITE_JPEG);
				}, 1000 / FPS_ENVOI);
			} catch (erreur) {
				if (!annule) setStatut({ type: "erreur", texte: messageErreurCamera(erreur) });
			}
		})();

		return () => {
			annule = true;
			window.clearInterval(minuterie);
			flux?.getTracks().forEach((piste) => piste.stop()); // éteint la webcam (et sa lumière)
		};
	}, [actif, socket, videoRef, setStatut]);
}

/** Entrées : actif (ce client regarde) et socket; sortie : URL de la dernière image reçue et indicateur « images récentes ». */
function useImagesRecues(actif, socket) {
	const [image, setImage] = useState(null);
	const [enDirect, setEnDirect] = useState(false);
	const derniereReception = useRef(0);

	useEffect(() => {
		if (!actif || !socket) return undefined;
		let ancienne = null;

		const surFrame = (data) => {
			const url = URL.createObjectURL(new Blob([data], { type: "image/jpeg" }));
			setImage(url);
			if (ancienne) URL.revokeObjectURL(ancienne); // sinon chaque image reste en mémoire
			ancienne = url;
			derniereReception.current = Date.now();
			setEnDirect(true);
		};
		const verification = window.setInterval(() => {
			setEnDirect(Date.now() - derniereReception.current < DELAI_IMAGE_PERDUE);
		}, 1000);

		socket.on("frame", surFrame);
		return () => {
			socket.off("frame", surFrame);
			window.clearInterval(verification);
			if (ancienne) URL.revokeObjectURL(ancienne);
			setImage(null);
			setEnDirect(false);
		};
	}, [actif, socket]);

	return { image, enDirect };
}

/** Entrée : aucune (l'id du salon vient de l'URL); sortie : le JSX de la table filmée. */
function BlackjackCamera() {
	const { id: salonId } = useParams();
	const navigate = useNavigate();
	// Rôle décidé par le serveur au "join" : "dealer" (créateur du salon, il filme), "joueur" ou "spectateur"
	const [role, setRole] = useState(null);
	const filme = role === "dealer";
	const [socket] = useState(connecterSocket);
	const [salon, setSalon] = useState(null); // état de la table : reçu au "join", puis à chaque "game:update"
	const [message, setMessage] = useState("");
	const [chargement, setChargement] = useState(false);
	const [statutCamera, setStatutCamera] = useState(null);
	const [montantMise, setMontantMise] = useState("");
	const videoRef = useRef(null);
	const [maintenant, setMaintenant] = useState(Date.now);

	useEffect(() => {
		socket.connect(); // reconnecte le même socket si le composant est remonté (StrictMode)
		return () => socket.disconnect();
	}, [socket]);
	

	// Rejoindre la room Socket.IO du salon (et la rejoindre de nouveau après une reconnexion)
	useEffect(() => {
		const rejoindre = () => socket.emit("join", salonId, (reponse) => {
			setMessage(reponse?.error ?? "");
			if (reponse?.role) setRole(reponse.role);
			if (reponse?.salon) setSalon(reponse.salon);
		});
		const surMiseAJour = ({ salon: salonMaj } = {}) => {
			if (salonMaj) setSalon(salonMaj);
		};
		// Le dealer a fermé le salon : retour au lobby
		const surFermeture = () => navigate("/", { replace: true, state: { message: "Ce salon a été fermé." } });
		const surErreur = ({ message: erreur } = {}) => setMessage(erreur ?? "Erreur pendant la partie.");
		rejoindre();
		socket.on("connect", rejoindre);
		socket.on("game:update", surMiseAJour);
		socket.on("salon:closed", surFermeture);
		socket.on("game:error", surErreur);
		return () => {
			socket.off("connect", rejoindre);
			socket.off("game:update", surMiseAJour);
			socket.off("salon:closed", surFermeture);
			socket.off("game:error", surErreur);
		};
	}, [socket, salonId, navigate]);

	useEffect(() => {
                if (salon?.status !== "waiting" || !salon?.debut_manche) return undefined;
                const minuterie = window.setInterval(() => setMaintenant(Date.now()), 250);
                return () => window.clearInterval(minuterie);
        }, [salon?.status, salon?.debut_manche]);
        const secondesAvantManche = salon?.status === "waiting" && salon?.debut_manche
                ? Math.max(0, Math.ceil((new Date(salon.debut_manche) - maintenant) / 1000))
                : null;

	const moi = salon?.players?.find((player) => String(player.id_compte) === String(lireUtilisateur()?.id));

	const cartesCroupier = salon?.dealer_hand ?? [];
	const totalCroupier = totalMain(cartesCroupier);
	const resultatCroupier = cartesCroupier.length === 0
		? "Aucune carte détectée."
		: totalCroupier > 21
			? "Le croupier a dépassé 21."
			: cartesCroupier.length === 2 && totalCroupier === 21
				? "Blackjack du croupier."
				: `Le croupier termine avec ${totalCroupier} points.`;

	/** Entrée : nom de l'événement; sortie : Promise de la réponse du serveur (erreur si pas de réponse en 5 s). */
	function demander(evenement, ...donnees) {
			return new Promise((resoudre) => {
					socket.timeout(5000).emit(evenement, ...donnees, (erreur, reponse) => {
							resoudre(erreur ? { error: "Le serveur ne répond pas." } : reponse);
					});
			});
	}	

	/** Entrée : aucune; sortie : Promise résolue après le départ (un joueur perd sa place et sa main). */
	async function quitterTable() {
		if (role === "joueur") {
			const mainEnJeu = salon?.status === "playing" || Number(moi?.bet) > 0 || moi?.hands?.some((main) => main.cartes?.length > 0);
			if (mainEnJeu && !window.confirm("Votre main sera perdue et votre place libérée. Quitter quand même ?")) return;
			setChargement(true);
			const reponse = await demander("leave");
			setChargement(false);
			if (reponse?.error) return setMessage(reponse.error);
		}
		navigate("/");
	}

	/** Entrée : aucune; sortie : Promise résolue après la fermeture du salon par son dealer. */
	async function fermerSalon() {
		if (!window.confirm("Voulez-vous fermer ce salon ? Tout le monde sera renvoyé au lobby.")) return;
		setChargement(true);
		const reponse = await demander("salon:close");
		setChargement(false);
		if (reponse?.error) return setMessage(reponse.error);
		navigate("/");
	}

	async function miser(evenement) {
		evenement.preventDefault();
        const mise = Number(montantMise);
        if (!Number.isFinite(mise) || mise <= 0) return setMessage("Entrez une mise plus grande que 0.");
        setChargement(true);
        const reponse = await demander("game:miser", { mise });
        setChargement(false);
        if (reponse?.error) return setMessage(reponse.error);
        setMontantMise("");
	}

	async function jouer(action) {
        setChargement(true);
        const reponse = await demander("game:move", { action });
        setChargement(false);
        if (reponse?.error) setMessage(reponse.error);
	}

	useCaptureCamera(filme, socket, videoRef, setStatutCamera);
	const { image, enDirect } = useImagesRecues(role !== null && !filme, socket); // en attendant le rôle : rien

	const couleurStatut = { succes: "is-success", erreur: "is-danger", info: "is-info" };
	const maMain = moi?.hands?.[0];
	const monTour = role === "joueur" && salon?.status === "playing" && moi?.isTurn;

	return (
		<section className="section">
			<div className="container">
				<div className="level is-mobile mb-4">
					<div className="level-left"><div className="level-item">
						<button className="button is-small is-text" onClick={quitterTable} disabled={chargement}>
							<span className="icon"><i className="fas fa-arrow-left" /></span>
							<span>{role === "joueur" ? "Quitter la table" : "Retour aux salons"}</span>
						</button>
					</div></div>
					{role === "dealer" && <div className="level-right"><div className="level-item">
						<button className="button is-small is-danger" onClick={fermerSalon} disabled={chargement}>
							<span className="icon"><i className="fas fa-times" /></span><span>Fermer le salon</span>
						</button>
					</div></div>}
				</div>

				<div className="columns">
					<div className="column">
						<div className="bj-table">
							<div className="level is-mobile">
								<div className="level-left" />
								<div className="level-right">
									{role === "spectateur" && <span className="tag is-info mr-2"><span className="icon"><i className="fas fa-eye" /></span><span>Spectateur</span></span>}
									<span className="tag is-dark">Salon {salonId}</span>
								</div>
							</div>
							<h1 className="title has-text-centered">Blackjack</h1>
							<p className="subtitle is-6 has-text-centered">{filme ? "Vous filmez cette table" : "Table réelle en direct"}</p>

							<div className="bj-zone">
								<div className="bj-camera">
									{filme
										? <video ref={videoRef} muted playsInline aria-label="Aperçu de votre caméra" />
										: image
											? <img src={image} alt="Caméra de la table" />
											: <p className="bj-camera-attente">En attente de la caméra du dealer...</p>}
								</div>
								{filme && statutCamera && <span className={`tag is-medium ${couleurStatut[statutCamera.type]}`} role="status">{statutCamera.texte}</span>}
								{!filme && image && <span className={`tag is-medium ${enDirect ? "is-success" : "is-danger"}`} role="status">
									<span className="icon"><i className="fas fa-circle" /></span><span>{enDirect ? "En direct" : "Caméra coupée"}</span>
								</span>}

								{secondesAvantManche !== null && <p className="has-text-centered mt-4">
									<span className="tag is-medium is-info">Début de la manche dans {secondesAvantManche} s</span>
								</p>}
								{salon?.status === "playing" && <p className="has-text-centered mt-4"><span className="tag is-medium is-success">Manche en cours</span></p>}

								{role === "joueur" && maMain && maMain.cartes?.length > 0 && (
									<div className="has-text-centered mt-4">
										<p>Votre main : {maMain.cartes.map((carte) => carte.rang).join(", ")} · Total : {totalMain(maMain.cartes)}</p>
										{maMain.status === "bust" && <p>Dépassé 21</p>}
										{maMain.status === "blackjack" && <p>Blackjack naturel</p>}
										{salon?.status === "finished" && moi.resultats?.[0] && (
											<p>Résultat : {LIBELLES_RESULTATS[moi.resultats[0]] ?? moi.resultats[0]}</p>
										)}
									</div>
								)}
								{salon?.status === "finished" && (
									<div className="notification is-info is-light mt-4" aria-live="polite">
										<p className="has-text-weight-semibold">Résultat du croupier</p>
										<p>Cartes : {cartesCroupier.map((carte) => carte?.rang ?? "?").join(", ") || "Aucune carte détectée"}</p>
										{cartesCroupier.length > 0 && <p>Total : {totalCroupier} · {resultatCroupier}</p>}
									</div>
								)}
								{salon?.status === "playing" && !salon.dealComplete && (
									<p className="has-text-centered mt-4">En attente de la détection des cartes initiales.</p>
								)}
								{monTour && (
									<div className="buttons is-centered mt-4">
										<button className="button is-link" onClick={() => jouer("hit")} disabled={chargement || moi.pendingAction}>
											Tirer
										</button>
										<button className="button is-light" onClick={() => jouer("stand")} disabled={chargement || moi.pendingAction}>
											Rester
										</button>
										{maMain?.cartes?.length === 2 && (
											<button className="button is-warning" onClick={() => jouer("double")} disabled={chargement || moi.pendingAction}>
												Doubler
											</button>
										)}
									</div>
								)}
								{moi?.pendingAction && <p className="has-text-centered mt-2">En attente de la carte détectée...</p>}
								{salon?.status === "playing" && salon.dealComplete && role === "joueur" && !moi?.isTurn
									&& moi?.status === "playing" && <p className="has-text-centered mt-4">En attente de votre tour.</p>}

								{role === "joueur" && (Number(moi?.bet) > 0
								? <p className="has-text-centered mt-4"><span className="tag is-medium is-warning">Votre mise : {moi.bet} $</span></p>
								: salon?.status !== "playing" && <form className="field has-addons has-addons-centered mt-4" onSubmit={miser}>
										<div className="control">
												<input className="input" type="number" min="0.01" step="0.01" placeholder="Montant"
														value={montantMise} onChange={(e) => setMontantMise(e.target.value)} disabled={chargement} />
										</div>
										<div className="control">
												<button className="button is-warning" type="submit" disabled={chargement}>Miser</button>
										</div>
								</form>)}
							</div>
						</div>
					</div>
					{/* Chat de la table : même socket que la page (connecterSocket retourne toujours la même connexion) */}
					<div className="column is-narrow">
						<Chat salonId={salonId} />
					</div>
				</div>

				{message && <div className="notification is-danger is-light mt-4 mb-0" role="alert">
					<button className="delete" aria-label="Fermer la notification" onClick={() => setMessage("")} />
					{message}
				</div>}
			</div>
		</section>
	);
}

export default BlackjackCamera;

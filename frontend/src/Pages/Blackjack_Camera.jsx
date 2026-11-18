import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { connecterSocket } from "../services/socket.js";
import "./Blackjack.css";
import Chat from "./Chat.jsx";
import { lireUtilisateur } from "./reglesBlackjack/outils.js";

const FPS_ENVOI = 10;
const QUALITE_JPEG = 0.7;
const DELAI_IMAGE_PERDUE = 3000; // ms sans image avant d'afficher « caméra coupée »

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
	const [joueursEnLigne, setJoueursEnLigne] = useState([]);
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
		const surMiseAJour = ({ salon: salonMaj, joueursEnLigne: joueursEnLigne } = {}) => {
			if (salonMaj) setSalon(salonMaj);
			if (joueursEnLigne) setJoueursEnLigne(joueursEnLigne);
		};
		// Le dealer a fermé le salon : retour au lobby
		const surFermeture = () => navigate("/", { replace: true, state: { message: "Ce salon a été fermé." } });
		rejoindre();
		socket.on("connect", rejoindre);
		socket.on("game:update", surMiseAJour);
		socket.on("salon:closed", surFermeture);
		return () => {
			socket.off("connect", rejoindre);
			socket.off("game:update", surMiseAJour);
			socket.off("salon:closed", surFermeture);
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

	useCaptureCamera(filme, socket, videoRef, setStatutCamera);
	const { image } = useImagesRecues(role !== null && !filme, socket); // en attendant le rôle : rien

	return (
		<section className="section" style={{
			backgroundImage: "linear-gradient(rgba(15, 23, 42, 0.45), rgba(15, 23, 42, 0.45)), url('/background.jpg')",
			backgroundSize: "cover",
			backgroundPosition: "center",
			backgroundRepeat: "no-repeat",
			minHeight: "calc(100vh - 4rem)",
		}}>
			{role !== "dealer" &&
				<div className="container">
					<div className="level is-mobile mb-4">
						<div className="level-left"><div className="level-item">
							<button className="button is-small is-text" onClick={quitterTable} disabled={chargement}>
								<span className="icon"><i className="fas fa-arrow-left" /></span>
								<span>{role === "joueur" ? "Quitter la table" : "Retour aux salons"}</span>
							</button>
						</div></div>
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

									{secondesAvantManche !== null && <p className="has-text-centered mt-4">
										<span className="tag is-medium is-info">Début de la manche dans {secondesAvantManche} s</span>
									</p>}
									{salon?.status === "playing" && <p className="has-text-centered mt-4"><span className="tag is-medium is-success">Manche en cours</span></p>}

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
			} {role === "dealer" &&
				<>
					{/* VUE POUR LE CROUPIER */}
					<div className="bj-croupier-page">
						<div className="bj-croupier-colonne">
							<div className="bj-zone bj-zone-croupier-cam">
								<div className="bj-camera-croupier">
									{filme
										? <video ref={videoRef} muted playsInline aria-label="Aperçu de votre caméra" />
										: image
											? <img src={image} alt="Caméra de la table" />
											: <p className="bj-camera-attente">En attente de la caméra du dealer...</p>}
								</div>
								{statutCamera?.type === "erreur" && (
									<span className="tag is-medium is-danger" role="status">{statutCamera.texte}</span>
								)}

                                {secondesAvantManche !== null && <p className="has-text-centered mt-4">
                                    <span className="tag is-medium is-info">Début de la manche dans {secondesAvantManche} s</span>
                                </p>}
								{salon?.status === "playing" && <p className="has-text-centered mt-4"><span className="tag is-medium is-success">Manche en cours</span></p>}
							</div>

							<Chat salonId={salonId} />

							<div className="bj-croupier-boutons">
								<button className="button is-small is-text" onClick={quitterTable} disabled={chargement}>
									<span className="icon"><i className="fas fa-arrow-left" /></span>
									<span>Retour aux salons</span>
								</button>
								<button className="button is-small is-danger" onClick={fermerSalon} disabled={chargement}>
									<span className="icon"><i className="fas fa-times" /></span>
									<span>Fermer le salon</span>
								</button>
							</div>

							{message && (
								<div className="notification is-danger is-light mt-2 mb-0" role="alert">
									<button className="delete" aria-label="Fermer la notification" onClick={() => setMessage("")} />
									{message}
								</div>
							)}
						</div>
						<div className="bj-joueurs-cartes">
							{/* <h3>Joueurs en ligne ({joueursEnLigne.length})</h3> */}

							<ul>
								{joueursEnLigne.map((nom) => (
									<div className="card bj-joueur-card">
										<div className="card-content">
											<p className="title is-5 mb-3">🟢 {nom}</p>
											<p className="">Action : </p>
											<p className="">Score main : </p>
											<p className="">Mise : </p>
										</div>
									</div>
								))}
							</ul>
						</div>
					</div>
				</>
			}
		</section>
	);
}

export default BlackjackCamera;

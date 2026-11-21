import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import BlackjackCamera from "../Pages/Blackjack_Camera.jsx";

const mocks = vi.hoisted(() => ({
	socket: {
		connect: vi.fn(),
		disconnect: vi.fn(),
		emit: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		timeout: vi.fn(),
	},
	useNavigate: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
	useNavigate: mocks.useNavigate,
	useParams: () => ({ id: "salon-test" }),
}));

vi.mock("../services/socket.js", () => ({
	connecterSocket: () => mocks.socket,
}));

vi.mock("../Pages/Chat.jsx", () => ({
	default: () => null,
}));

const salonJoueur = {
	_id: "salon-test",
	status: "playing",
	dealer_hand: [{ rang: "7" }],
	currentTurnSeat: 0,
	players: [{
		id_compte: "joueur-test",
		seat_index: 0,
		bet: 10,
		hands: [{
			cartes: [{ rang: "10" }, { rang: "6" }],
			mise: 10,
			status: "playing",
		}],
		status: "playing",
		pendingAction: null,
		isTurn: true,
	}],
};

function reponseJson(donnees, ok = true) {
	return Promise.resolve({
		ok,
		json: () => Promise.resolve(donnees),
	});
}

beforeEach(() => {
	localStorage.setItem("token", `header.${btoa(JSON.stringify({ id: "joueur-test" }))}.signature`);
	mocks.socket.emit.mockImplementation((evenement, ...arguments_) => {
		if (evenement === "join") {
			arguments_[1]({ salon: salonJoueur, role: "joueur" });
		}
	});
	mocks.socket.timeout.mockReturnValue({ emit: vi.fn() });
});

afterEach(() => {
	localStorage.clear();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

test.each([
	["hit", "Tirer"],
	["stand", "Rester"],
	["double", "Doubler"],
])("%s est envoyé au backend par PATCH /gameStatus", async (action, libelle) => {
	const fetchMock = vi.fn((url) => {
		if (String(url).endsWith("/solde")) return reponseJson({ solde: 100 });
		return reponseJson({
			solde: action === "double" ? 90 : 100,
			gameStatus: {
				status: "playing",
				dealer_hand: salonJoueur.dealer_hand,
				players: salonJoueur.players.map((joueur) => ({
					...joueur,
					pendingAction: action === "hit" || action === "double" ? action : null,
					status: action === "stand" ? "stand" : "playing",
					isTurn: action !== "stand",
				})),
				currentTurnSeat: action === "stand" ? -1 : 0,
			},
		});
	});
	vi.stubGlobal("fetch", fetchMock);
	render(<BlackjackCamera />);

	const bouton = await screen.findByRole("button", { name: libelle });
	const disposition = screen.getByRole("group", { name: "Caméra et état de la manche" });
	expect(disposition.children[0]).toHaveClass("bj-live-state");
	expect(disposition.children[1]).toHaveClass("bj-camera-zone");
	await waitFor(() => expect(bouton).toBeEnabled());
	fireEvent.click(bouton);

	await waitFor(() => {
		const requeteAction = fetchMock.mock.calls.find(([, options]) => options?.method === "PATCH");
		expect(requeteAction).toBeDefined();
		expect(requeteAction[0]).toBe("http://localhost:3000/gameStatus");
		expect(JSON.parse(requeteAction[1].body)).toEqual({ salonId: "salon-test", action });
	});
	expect(screen.queryByRole("button", { name: /séparer|split/i })).not.toBeInTheDocument();
});

test("après le règlement, miser de nouveau réserve la manche suivante", async () => {
	const salonTermine = {
		...salonJoueur,
		status: "finished",
		players: salonJoueur.players.map((joueur) => ({
			...joueur,
			status: "finished",
			isTurn: false,
			hands: [{ ...joueur.hands[0], resultat: "gagne", gain: 20 }],
		})),
	};
	mocks.socket.emit.mockImplementation((evenement, ...arguments_) => {
		if (evenement === "join") arguments_[1]({ salon: salonTermine, role: "joueur" });
	});
	const emettreMise = vi.fn((evenement, _donnees, callback) => callback(null, { ok: true, solde: 85 }));
	mocks.socket.timeout.mockReturnValue({ emit: emettreMise });
	vi.stubGlobal("fetch", vi.fn(() => reponseJson({ solde: 100 })));

	render(<BlackjackCamera />);
	fireEvent.change(await screen.findByRole("spinbutton", { name: "Montant de la mise" }), {
		target: { value: "15" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Miser pour rejouer" }));

	await waitFor(() => expect(emettreMise).toHaveBeenCalled());
	expect(emettreMise.mock.calls[0][0]).toBe("game:miser");
	expect(emettreMise.mock.calls[0][1]).toEqual({ mise: 15 });
});

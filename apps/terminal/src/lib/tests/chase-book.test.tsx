// @vitest-environment jsdom
import type { L2BookWsEvent } from "@nktkas/hyperliquid";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChaseBook } from "@/hooks/trade/use-chase-book";

const sdk = vi.hoisted(() => ({
	transports: [] as { socket: EventTarget; close: ReturnType<typeof vi.fn> }[],
	subscriptions: [] as { params: { coin: string }; receive: (book: L2BookWsEvent) => void; failure: AbortController }[],
}));
vi.mock("@/lib/network", () => ({ isTestnet: () => false }));
vi.mock("@nktkas/hyperliquid", () => ({
	WebSocketTransport: class {
		socket = new EventTarget();
		close = vi.fn().mockResolvedValue(undefined);
		constructor() {
			sdk.transports.push(this);
		}
	},
	SubscriptionClient: class {
		async l2Book(params: { coin: string }, receive: (book: L2BookWsEvent) => void) {
			const failure = new AbortController();
			sdk.subscriptions.push({ params, receive, failure });
			return { failureSignal: failure.signal };
		}
	},
}));

let root: Root;
let host: HTMLDivElement;
function Probe({ coin }: { coin: string | undefined }) {
	const book = useChaseBook(coin);
	return book?.levels[0][0]?.px ?? "waiting";
}
const event = (coin: string, px: string): L2BookWsEvent => ({
	coin,
	time: Date.now(),
	levels: [[{ px, sz: "1", n: 1 }], [{ px: String(Number(px) + 1), sz: "1", n: 1 }]],
});
async function render(coin: string | undefined) {
	await act(async () => root.render(createElement(Probe, { coin })));
}
beforeEach(() => {
	vi.useFakeTimers();
	sdk.transports.length = 0;
	sdk.subscriptions.length = 0;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
});

it("subscribes to only the raw book and clears a disconnected snapshot until fresh data arrives", async () => {
	await render("BTC");
	expect(sdk.subscriptions[0].params).toEqual({ coin: "BTC" });
	act(() => sdk.subscriptions[0].receive(event("BTC", "99")));
	expect(host.textContent).toBe("99");
	act(() => sdk.transports[0].socket.dispatchEvent(new Event("close")));
	expect(host.textContent).toBe("waiting");
	act(() => sdk.subscriptions[0].receive(event("BTC", "98")));
	expect(host.textContent).toBe("98");
});

it("closes the old socket on market changes and ignores its late deliveries", async () => {
	await render("BTC");
	act(() => sdk.subscriptions[0].receive(event("BTC", "99")));
	await render("xyz:SP500");
	expect(sdk.transports[0].close).toHaveBeenCalledOnce();
	act(() => sdk.subscriptions[0].receive(event("BTC", "97")));
	expect(host.textContent).toBe("waiting");
	act(() => sdk.subscriptions[1].receive(event("xyz:SP500", "7670")));
	expect(host.textContent).toBe("7670");
	await render(undefined);
	expect(sdk.transports[1].close).toHaveBeenCalledOnce();
	expect(host.textContent).toBe("waiting");
});

it("retries a failed subscription and stops pending retries when the chase ends", async () => {
	await render("BTC");
	act(() => sdk.subscriptions[0].failure.abort());
	await act(async () => vi.advanceTimersByTimeAsync(1_000));
	expect(sdk.subscriptions).toHaveLength(2);
	act(() => sdk.subscriptions[1].failure.abort());
	await render(undefined);
	await act(async () => vi.advanceTimersByTimeAsync(2_000));
	expect(sdk.subscriptions).toHaveLength(2);
	expect(sdk.transports[0].close).toHaveBeenCalledOnce();
});

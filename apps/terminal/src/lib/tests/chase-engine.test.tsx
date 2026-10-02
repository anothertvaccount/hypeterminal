// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHASE_MODIFY_INTERVAL_MS, CHASE_TIMEOUT_MS, type ChaseEntry } from "@/domain/trade/order/chase";
import { useChaseOrderEngine } from "@/hooks/trade/use-chase-order";
import type { OpenOrder } from "@/lib/trade/open-orders";
import { useChaseOrderStore } from "@/stores/use-chase-order-store";

const mocks = vi.hoisted(() => ({
	paper: false,
	orders: [] as OpenOrder[],
	levels: [[{ px: "99" }], [{ px: "101" }]],
	position: { szi: "1" } as { szi: string } | null,
	loading: false,
	bookReady: true,
	error: false,
	address: "0x0000000000000000000000000000000000000001",
	modify: vi.fn(),
	place: vi.fn(),
	submit: vi.fn(),
	info: { frontendOpenOrders: vi.fn(), orderStatus: vi.fn(), clearinghouseState: vi.fn() },
	paperOutcomes: {} as Record<number, string>,
	cancel: vi.fn(),
	addOrder: vi.fn(),
	markets: { getAssetId: () => 0, getSzDecimals: () => 3 },
	paperActions: { repriceOrder: vi.fn() },
}));
vi.mock("@/config/paper", () => ({
	get PAPER_TRADE() {
		return mocks.paper;
	},
}));
vi.mock("@/lib/hyperliquid", () => ({
	useTradingSession: () => ({ address: mocks.address, isActive: true }),
	useMarkets: () => mocks.markets,
	useUserPositions: () => ({ getPosition: () => mocks.position, isLoading: mocks.loading, hasError: mocks.error }),
	useExchange: (method: string) => ({ mutateAsync: method === "order" ? mocks.place : mocks.modify }),
	getInfoClient: () => mocks.info,
	useSubscription: (channel: string) => ({
		data:
			channel === "openOrders"
				? { orders: mocks.orders }
				: channel === "l2Book"
					? { levels: mocks.levels }
					: { mids: { BTC: "100" } },
	}),
}));
vi.mock("@/hooks/trade/use-cancel-open-orders", () => ({ useCancelOpenOrders: () => mocks.cancel }));
vi.mock("@/hooks/trade/use-submit-plan", () => ({ useSubmitPlan: () => ({ submitPlan: mocks.submit }) }));
vi.mock("@/hooks/trade/use-chase-book", () => ({
	useChaseBook: () => (mocks.bookReady ? { coin: "BTC", levels: mocks.levels } : undefined),
}));
vi.mock("@/stores/use-order-queue-store", () => ({ useOrderQueueActions: () => ({ addOrder: mocks.addOrder }) }));
vi.mock("@/stores/use-paper-store", () => ({
	usePaperOpenOrderRows: () => mocks.orders,
	usePaperActions: () => mocks.paperActions,
	usePaperTradingStore: { getState: () => ({ outcomeByOid: mocks.paperOutcomes }) },
}));

let root: Root;
let host: HTMLDivElement;
function Probe() {
	useChaseOrderEngine();
	return null;
}
async function render() {
	await act(async () => root.render(createElement(Probe)));
}
async function advance(ms = CHASE_MODIFY_INTERVAL_MS) {
	await act(async () => vi.advanceTimersByTimeAsync(ms));
}
async function start(mode: ChaseEntry["mode"] = "close", side: ChaseEntry["side"] = "sell", cloid?: `0x${string}`) {
	mocks.position = { szi: side === "sell" ? "1" : "-1" };
	mocks.orders = [
		{
			coin: "BTC",
			side: side === "buy" ? "B" : "A",
			limitPx: "100",
			sz: "1",
			oid: 77,
			timestamp: 0,
			origSz: "1",
			triggerCondition: "",
			isTrigger: false,
			triggerPx: "0",
			children: [],
			isPositionTpsl: false,
			reduceOnly: mode === "close",
			orderType: "Limit",
			tif: "Alo",
			cloid: cloid ?? null,
		},
	];
	useChaseOrderStore.getState().actions.start({
		coin: "BTC",
		oid: 77,
		cloid,
		tif: "Alo",
		side,
		sizeText: "1",
		reduceOnly: mode === "close",
		startedAt: Date.now(),
		mode,
	});
	await render();
}
function expectReprice(price: string, mode: ChaseEntry["mode"], side: ChaseEntry["side"]) {
	if (mocks.paper) {
		expect(mocks.paperActions.repriceOrder).toHaveBeenLastCalledWith(77, Number(price));
		expect(mocks.modify).not.toHaveBeenCalled();
	} else {
		expect(mocks.modify).toHaveBeenLastCalledWith({
			modifies: [
				{
					oid: 77,
					order: { a: 0, b: side === "buy", p: price, s: "1", r: mode === "close", t: { limit: { tif: "Alo" } } },
				},
			],
		});
		expect(mocks.paperActions.repriceOrder).not.toHaveBeenCalled();
	}
	expect(mocks.cancel).not.toHaveBeenCalled();
	expect(useChaseOrderStore.getState().entry?.mode).toBe(mode);
}
const writeCount = () => mocks.modify.mock.calls.length + mocks.paperActions.repriceOrder.mock.calls.length;

beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
	mocks.paper = false;
	mocks.orders = [];
	mocks.loading = false;
	mocks.bookReady = true;
	mocks.error = false;
	mocks.address = "0x0000000000000000000000000000000000000001";
	mocks.paperOutcomes = {};
	mocks.position = { szi: "1" };
	mocks.levels = [[{ px: "99" }], [{ px: "101" }]];
	mocks.modify.mockResolvedValue({ response: { data: { statuses: [{ resting: { oid: 77 } }] } } });
	mocks.place.mockResolvedValue({ response: { data: { statuses: [{ resting: { oid: 90 } }] } } });
	mocks.submit.mockResolvedValue({ ok: true, outcome: "resting", oid: 90 });
	mocks.info.frontendOpenOrders.mockResolvedValue([]);
	mocks.info.orderStatus.mockResolvedValue({ status: "unknownOid" });
	mocks.info.clearinghouseState.mockImplementation(async () => ({
		assetPositions: mocks.position ? [{ position: { coin: "BTC", szi: mocks.position.szi } }] : [],
	}));
	mocks.cancel.mockResolvedValue({ cancelled: 1, errors: [] });
	useChaseOrderStore.getState().actions.clear();
	useChaseOrderStore.getState().actions.clearHistory();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	useChaseOrderStore.getState().actions.clear();
	vi.useRealTimers();
});

describe.each([false, true])("chase timer with paper=%s", (paper) => {
	it.each([
		["close", "sell"],
		["close", "buy"],
		["entry", "sell"],
		["entry", "buy"],
	] as const)("%s %s follows the touch every 750 ms", async (mode, side) => {
		mocks.paper = paper;
		await start(mode, side);
		const initial = side === "buy" ? "99" : "101";
		const moved = side === "buy" ? "98" : "102";
		expectReprice(initial, mode, side);
		expect(writeCount()).toBe(1);
		mocks.orders = [{ ...mocks.orders[0], limitPx: initial }];
		mocks.levels = [[{ px: "98" }], [{ px: "102" }]];
		await render(); // Public book updates must not restart/cancel the chase.
		await advance(749);
		expect(writeCount()).toBe(1);
		await advance(1);
		expectReprice(moved, mode, side);
		expect(writeCount()).toBe(2);
		mocks.orders = [{ ...mocks.orders[0], limitPx: moved }];
		await render();
		await advance();
		expect(writeCount()).toBe(2); // Already at the touch: no needless modify.
	});
});

describe("close chase position guards", () => {
	it("keeps managing the order when market metadata and cancellation callbacks refresh", async () => {
		await start();
		const previousCancel = mocks.cancel;
		mocks.markets = { ...mocks.markets };
		mocks.cancel = vi.fn().mockResolvedValue({ cancelled: 1, errors: [] });
		mocks.orders = [{ ...mocks.orders[0], limitPx: "101" }];
		mocks.levels = [[{ px: "99" }], [{ px: "102" }]];
		await render();
		expect(previousCancel).not.toHaveBeenCalled();
		expect(mocks.cancel).not.toHaveBeenCalled();
		expect(useChaseOrderStore.getState().history).toEqual([]);
		await advance();
		expectReprice("102", "close", "sell");
	});
	it("reprices on the interval when wall-clock rounding puts its callback one millisecond early", async () => {
		await start("entry");
		mocks.orders = [{ ...mocks.orders[0], limitPx: "101" }];
		mocks.levels = [[{ px: "99" }], [{ px: "102" }]];
		await render();
		vi.setSystemTime(Date.now() - 1);
		await advance();
		expectReprice("102", "entry", "sell");
	});
	it("waits for the isolated raw book and resumes after it reconnects", async () => {
		mocks.bookReady = false;
		await start();
		await advance();
		expect(writeCount()).toBe(0);
		mocks.bookReady = true;
		await render();
		await advance();
		expectReprice("101", "close", "sell");
	});
	it("waits for a loaded position, then resumes on the next tick", async () => {
		mocks.loading = true;
		await start();
		await advance();
		expect(writeCount()).toBe(0);
		expect(mocks.cancel).not.toHaveBeenCalled();
		mocks.loading = false;
		await render();
		await advance();
		expectReprice("101", "close", "sell");
	});
	it("retires a close when the position is flat", async () => {
		await start();
		mocks.modify.mockClear();
		mocks.position = { szi: "0" };
		await render();
		await advance();
		expect(writeCount()).toBe(0);
		expect(useChaseOrderStore.getState().entry).toBeNull();
		expect(useChaseOrderStore.getState().history[0].outcome).toBe("completed");
		expect(mocks.cancel).toHaveBeenCalledWith([mocks.orders[0]], { source: "chase", suppressExpectedMissing: true });
	});
	it.each([
		["sell", "97.5", false],
		["buy", "102.5", true],
	] as const)(
		"cancels a resting sub-$10 %s tail and closes it with a reduce-only market order",
		async (side, price, buy) => {
			await start("close", side);
			mocks.modify.mockClear();
			mocks.position = { szi: side === "sell" ? "0.05" : "-0.05" }; // $5 at the test mark: too small to replace.
			mocks.orders = [{ ...mocks.orders[0], sz: "0.05" }];
			const tailOrder = mocks.orders[0];
			mocks.info.orderStatus
				.mockResolvedValueOnce(status(tailOrder, "open"))
				.mockResolvedValueOnce(status(tailOrder, "canceled"));
			mocks.place.mockResolvedValueOnce({ response: { data: { statuses: [{ filled: { oid: 91 } }] } } });
			await render();
			await advance();
			expect(writeCount()).toBe(0);
			expect(mocks.cancel).toHaveBeenCalledOnce();
			expect(mocks.cancel.mock.lastCall).toEqual([[tailOrder], { source: "chase", suppressExpectedMissing: true }]);
			expect(mocks.place).toHaveBeenCalledOnce();
			expect(mocks.place.mock.lastCall?.[0]).toMatchObject({
				grouping: "na",
				orders: [{ a: 0, b: buy, p: price, s: "0.05", r: true, t: { limit: { tif: "FrontendMarket" } } }],
			});
			await advance(4_500);
			expect(mocks.place).toHaveBeenCalledOnce();
			await advance(750);
			expect(mocks.place).toHaveBeenCalledTimes(2); // Retry if the venue leaves a valid residual after the market close.
			expect(useChaseOrderStore.getState().entry?.mode).toBe("close");
			expect(useChaseOrderStore.getState().history).toHaveLength(0);
		},
	);
	it("keeps retrying a rejected sub-$10 market close with a cooldown", async () => {
		await start();
		mocks.position = { szi: "0.05" };
		mocks.orders = [{ ...mocks.orders[0], sz: "0.05" }];
		mocks.info.orderStatus
			.mockResolvedValueOnce(status(mocks.orders[0], "open"))
			.mockResolvedValueOnce(status(mocks.orders[0], "canceled"));
		mocks.place.mockResolvedValueOnce({
			response: { data: { statuses: [{ error: "MinTradeNtl: Order must have minimum value of $10" }] } },
		});
		await render();
		await advance();
		expect(mocks.place).toHaveBeenCalledOnce();
		expect(useChaseOrderStore.getState().entry?.mode).toBe("close");
		await advance(4_500);
		expect(mocks.place).toHaveBeenCalledOnce();
		await advance(750);
		expect(mocks.place).toHaveBeenCalledTimes(2);
		expect(mocks.addOrder).toHaveBeenCalledOnce();
		expect(useChaseOrderStore.getState().entry?.mode).toBe("close");
	});
	it("holds a missing order while the position is open without creating another", async () => {
		await start();
		mocks.orders = [];
		mocks.modify.mockClear();
		await render();
		await advance(6_000);
		expect(writeCount()).toBe(0);
		expect(useChaseOrderStore.getState().entry?.mode).toBe("close");
		expect(mocks.cancel).not.toHaveBeenCalled();
	});
	it("reprices only the remaining size after a partial fill", async () => {
		await start();
		mocks.orders = [{ ...mocks.orders[0], origSz: "0.5", sz: "0.5", limitPx: "101" }];
		mocks.position = { szi: "0.5" };
		mocks.levels = [[{ px: "99" }], [{ px: "102" }]];
		await render();
		await advance();
		expect(mocks.modify.mock.lastCall?.[0].modifies[0].order).toMatchObject({ p: "102", s: "0.5", r: true });
		expect(mocks.cancel).not.toHaveBeenCalled();
	});
	it("runs beyond the entry timeout while an entry chase still expires", async () => {
		await start();
		mocks.orders = [{ ...mocks.orders[0], limitPx: "101" }];
		await render();
		await advance(CHASE_TIMEOUT_MS + CHASE_MODIFY_INTERVAL_MS);
		expect(useChaseOrderStore.getState().entry?.mode).toBe("close");
		expect(mocks.cancel).not.toHaveBeenCalled();
		await act(async () => root.render(null));
		mocks.cancel.mockClear();
		await start("entry");
		await advance(CHASE_TIMEOUT_MS);
		expect(useChaseOrderStore.getState().entry).toBeNull();
		expect(useChaseOrderStore.getState().history[0].outcome).toBe("timeout");
		expect(mocks.cancel).toHaveBeenCalled();
	});
});

const status = (order: OpenOrder, state = "canceled") => ({
	status: "order",
	order: { order, status: state, statusTimestamp: Date.now() },
});
describe("chase races and close recovery", () => {
	it.each(["filled", "canceled"])(
		"replaces a %s order with only the freshly verified remainder and keeps closing",
		async (state) => {
			await start();
			const original = mocks.orders[0];
			mocks.orders = [];
			mocks.info.orderStatus.mockResolvedValue(status(original, state));
			mocks.info.clearinghouseState.mockResolvedValue({ assetPositions: [{ position: { coin: "BTC", szi: "0.4" } }] });
			await render();
			await advance(6_000);
			expect(mocks.place).toHaveBeenCalledOnce();
			expect(mocks.place.mock.lastCall?.[0]).toMatchObject({
				grouping: "na",
				orders: [{ a: 0, b: false, p: "101", s: "0.4", r: true, t: { limit: { tif: "Alo" } } }],
			});
			expect(useChaseOrderStore.getState().entry?.mode).toBe("close");
			expect(mocks.addOrder).not.toHaveBeenCalled();
			mocks.orders = [{ ...original, oid: 90, limitPx: "101", origSz: "0.4", sz: "0.4" }];
			mocks.position = { szi: "0.4" };
			mocks.levels = [[{ px: "99" }], [{ px: "102" }]];
			mocks.modify.mockResolvedValue({ response: { data: { statuses: [{ resting: { oid: 90 } }] } } });
			await render();
			await advance();
			expect(mocks.modify.mock.lastCall?.[0].modifies[0]).toMatchObject({ oid: 90, order: { s: "0.4", p: "102" } });
			mocks.position = null;
			await render();
			await advance();
			expect(useChaseOrderStore.getState().entry).toBeNull();
			expect(useChaseOrderStore.getState().history[0].outcome).toBe("completed");
			expect(mocks.place).toHaveBeenCalledOnce();
		},
	);
	it("reconciles an omitted open order without posting another", async () => {
		await start();
		mocks.info.orderStatus.mockResolvedValue(status({ ...mocks.orders[0], limitPx: "101" }, "open"));
		mocks.orders = [];
		await render();
		await advance(9_000);
		expect(mocks.info.orderStatus).toHaveBeenCalled();
		expect(mocks.place).not.toHaveBeenCalled();
		expect(mocks.addOrder).not.toHaveBeenCalled();
		expect(useChaseOrderStore.getState().entry?.mode).toBe("close");
	});
	it("adopts a replacement found by the final read instead of duplicating it", async () => {
		await start("close", "sell", "0x00000000000000000000000000000001");
		const original = mocks.orders[0];
		mocks.orders = [];
		mocks.info.orderStatus.mockResolvedValue(status(original));
		mocks.info.frontendOpenOrders
			.mockResolvedValueOnce([])
			.mockResolvedValue([{ ...original, oid: 88, limitPx: "101", origSz: "0.5", sz: "0.5" }]);
		await render();
		await advance(6_000);
		expect(mocks.info.frontendOpenOrders).toHaveBeenCalledTimes(2);
		expect(mocks.place).not.toHaveBeenCalled();
		mocks.levels = [[{ px: "99" }], [{ px: "102" }]];
		await render();
		await advance();
		expect(mocks.modify.mock.lastCall?.[0].modifies[0]).toMatchObject({ oid: 88, order: { s: "0.5" } });
	});
	it("does not take over an unrelated reduce-only order during recovery", async () => {
		await start("close", "sell", "0x00000000000000000000000000000001");
		const original = mocks.orders[0];
		mocks.orders = [];
		mocks.info.orderStatus.mockResolvedValue(status(original));
		mocks.info.frontendOpenOrders.mockResolvedValue([
			{ ...original, oid: 88, cloid: "0x00000000000000000000000000000002" },
		]);
		await render();
		await advance(6_000);
		expect(mocks.place).toHaveBeenCalledOnce();
		expect(mocks.modify.mock.calls.every(([params]) => params.modifies[0].oid !== 88)).toBe(true);
	});
	it.each(["unknownOid", "open"])("uses confirmed gone-race proof despite a lagging %s status read", async (state) => {
		mocks.modify.mockRejectedValueOnce(new Error("Order 0: Cannot modify canceled or filled order"));
		await start();
		mocks.info.orderStatus.mockResolvedValue(
			state === "open" ? status(mocks.orders[0], "open") : { status: "unknownOid" },
		);
		await advance();
		expect(mocks.place).toHaveBeenCalledOnce();
		expect(mocks.addOrder).not.toHaveBeenCalled();
	});
	it("stops an acknowledged order before its first subscription snapshot", async () => {
		mocks.orders = [];
		const order = {
			coin: "BTC",
			side: "A",
			oid: 77,
			limitPx: "101",
			sz: "1",
			origSz: "1",
			reduceOnly: true,
			isTrigger: false,
		};
		mocks.info.orderStatus.mockResolvedValue(status(order as OpenOrder, "open"));
		useChaseOrderStore.getState().actions.start({
			coin: "BTC",
			oid: 77,
			side: "sell",
			sizeText: "1",
			reduceOnly: true,
			mode: "close",
			startedAt: Date.now(),
		});
		await render();
		await act(async () => useChaseOrderStore.getState().actions.clear());
		expect(mocks.cancel).toHaveBeenCalledOnce();
		expect(mocks.cancel.mock.lastCall?.[0][0].oid).toBe(77);
		expect(mocks.place).not.toHaveBeenCalled();
	});
	it("follows a new modify ACK before the delayed old snapshot catches up", async () => {
		mocks.modify.mockResolvedValue({ response: { data: { statuses: [{ resting: { oid: 88 } }] } } });
		await start();
		mocks.levels = [[{ px: "99" }], [{ px: "102" }]];
		await render(); // Still contains oid77; the ACK has already moved it to88.
		await advance();
		expect(mocks.modify.mock.lastCall?.[0].modifies[0].oid).toBe(88);
		expect(mocks.addOrder).not.toHaveBeenCalled();
	});
	it.each(["rejection", "status"])("silences the expected modify race from a %s and resumes closing", async (kind) => {
		const message = "Order 0: Cannot modify canceled or filled order";
		if (kind === "rejection") mocks.modify.mockRejectedValueOnce(new Error(message));
		else mocks.modify.mockResolvedValueOnce({ response: { data: { statuses: [{ error: message }] } } });
		await start();
		mocks.info.orderStatus.mockResolvedValue(status(mocks.orders[0], "filled"));
		mocks.info.clearinghouseState.mockResolvedValue({ assetPositions: [{ position: { coin: "BTC", szi: "0.3" } }] });
		await advance();
		expect(mocks.place).toHaveBeenCalledOnce();
		expect(mocks.place.mock.lastCall?.[0].orders[0].s).toBe("0.3");
		expect(mocks.modify).toHaveBeenCalledOnce();
		expect(mocks.addOrder).not.toHaveBeenCalled();
	});
	it("marks a modify failure as Chase while continuing to retry", async () => {
		mocks.modify.mockRejectedValue(new Error("Insufficient margin"));
		await start();
		await advance(2_250);
		expect(mocks.modify).toHaveBeenCalledTimes(4);
		expect(mocks.addOrder).toHaveBeenCalledOnce();
		expect(mocks.addOrder.mock.lastCall?.[0]).toMatchObject({
			source: "chase",
			status: "failed",
			error: "Insufficient margin",
		});
	});
	it("does not overlap modifies and cancels the new ACK when stopped mid-write", async () => {
		let resolveModify!: (value: unknown) => void;
		mocks.modify.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveModify = resolve;
				}),
		);
		await start();
		await advance(2_250);
		expect(mocks.modify).toHaveBeenCalledOnce();
		await act(async () => useChaseOrderStore.getState().actions.clear());
		expect(mocks.cancel).not.toHaveBeenCalled();
		await act(async () => resolveModify({ response: { data: { statuses: [{ resting: { oid: 88 } }] } } }));
		expect(mocks.cancel).toHaveBeenCalledOnce();
		expect(mocks.cancel.mock.lastCall?.[0][0].oid).toBe(88);
		expect(mocks.place).not.toHaveBeenCalled();
	});
	it("does not post after Stop Chase while a position read is pending", async () => {
		await start();
		mocks.info.orderStatus.mockResolvedValue(status(mocks.orders[0]));
		let resolvePosition!: (value: unknown) => void;
		mocks.info.clearinghouseState.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolvePosition = resolve;
				}),
		);
		mocks.orders = [];
		await render();
		await advance(6_000);
		await act(async () => useChaseOrderStore.getState().actions.clear());
		await act(async () => resolvePosition({ assetPositions: [{ position: { coin: "BTC", szi: "0.5" } }] }));
		expect(mocks.place).not.toHaveBeenCalled();
		expect(mocks.addOrder).not.toHaveBeenCalled();
	});
	it("keeps an ambiguous replacement pending by CLOID instead of posting twice", async () => {
		await start();
		const original = mocks.orders[0];
		mocks.info.orderStatus.mockImplementation(async ({ oid }) =>
			typeof oid === "number" ? status(original) : { status: "unknownOid" },
		);
		mocks.place.mockRejectedValue(new Error("HTTP request error: Failed to fetch"));
		mocks.orders = [];
		await render();
		await advance(9_000);
		expect(mocks.place).toHaveBeenCalledOnce();
		const cloid = mocks.place.mock.lastCall?.[0].orders[0].c;
		expect(mocks.info.orderStatus.mock.calls.some(([params]) => params.oid === cloid)).toBe(true);
		mocks.info.orderStatus.mockResolvedValue(status({ ...original, oid: 90, cloid, limitPx: "101" }, "open"));
		await advance();
		expect(mocks.place).toHaveBeenCalledOnce();
	});
	it("waits when the position subscription reports an error", async () => {
		mocks.error = true;
		await start();
		await advance(6_000);
		expect(mocks.modify).not.toHaveBeenCalled();
		expect(mocks.place).not.toHaveBeenCalled();
		expect(mocks.cancel).not.toHaveBeenCalled();
		expect(useChaseOrderStore.getState().entry?.mode).toBe("close");
	});
	it("does not manage a retained chase under a different account", async () => {
		await start();
		mocks.address = "0x0000000000000000000000000000000000000002";
		await render();
		await advance(6_000);
		expect(mocks.modify).toHaveBeenCalledOnce();
		expect(mocks.cancel).not.toHaveBeenCalled();
		expect(mocks.place).not.toHaveBeenCalled();
	});
});

describe("Chase Close startup intent", () => {
	async function startIntent() {
		useChaseOrderStore.getState().actions.start({
			coin: "BTC",
			side: "sell",
			sizeText: "1",
			reduceOnly: true,
			tif: "Alo",
			mode: "close",
			placementPending: true,
			startedAt: Date.now(),
		});
		await render();
	}

	it("quietly retries repeated initial post-only races using fresh prices and remaining size", async () => {
		mocks.place.mockImplementation(async () => ({
			response: {
				data: {
					statuses:
						mocks.place.mock.calls.length <= 4
							? [{ error: "Post only order would have immediately matched, bbo was 30555@30558. asset=110000" }]
							: [{ resting: { oid: 90 } }],
				},
			},
		}));
		await startIntent();
		for (let attempt = 1; attempt <= 4; attempt++) {
			mocks.levels = [[{ px: "99" }], [{ px: String(101 + attempt) }]];
			mocks.position = { szi: "0.5" };
			await render();
			await advance();
		}
		expect(mocks.place).toHaveBeenCalledTimes(5);
		expect(mocks.place.mock.calls.map(([plan]) => plan.orders[0].p)).toEqual(["101", "102", "103", "104", "105"]);
		expect(mocks.place.mock.calls.map(([plan]) => plan.orders[0].s)).toEqual(["1", "0.5", "0.5", "0.5", "0.5"]);
		expect(mocks.place.mock.calls.every(([plan]) => plan.orders[0].r && plan.orders[0].t.limit.tif === "Alo")).toBe(
			true,
		);
		expect(mocks.addOrder).toHaveBeenCalledTimes(1);
		expect(mocks.addOrder).toHaveBeenCalledWith(expect.objectContaining({ source: "chase", status: "success" }));
		expect(mocks.modify).not.toHaveBeenCalled();
		expect(useChaseOrderStore.getState().entry?.mode).toBe("close");
	});

	it("holds an ambiguous initial write until CLOID reconciliation instead of duplicating it", async () => {
		mocks.place.mockRejectedValue(new Error("Connection lost after submission"));
		await startIntent();
		await advance(9000);
		expect(mocks.place).toHaveBeenCalledTimes(1);
		const sent = mocks.place.mock.calls[0][0].orders[0];
		expect(mocks.info.orderStatus).toHaveBeenCalledWith({ user: mocks.address, oid: sent.c }, expect.any(AbortSignal));
		mocks.info.orderStatus.mockResolvedValue({
			status: "order",
			order: {
				status: "open",
				order: {
					coin: "BTC",
					oid: 90,
					cloid: sent.c,
					side: "A",
					reduceOnly: true,
					isTrigger: false,
					limitPx: sent.p,
					sz: sent.s,
					origSz: sent.s,
					tif: "Alo",
				},
			},
		});
		await advance();
		mocks.levels = [[{ px: "99" }], [{ px: "102" }]];
		await render();
		await advance();
		expect(mocks.place).toHaveBeenCalledTimes(1);
		expect(mocks.modify.mock.calls[0][0].modifies[0].oid).toBe(90);
	});

	it("waits for a real book rather than guessing a live post-only price", async () => {
		mocks.bookReady = false;
		await startIntent();
		await advance(9000);
		expect(mocks.place).not.toHaveBeenCalled();
		mocks.bookReady = true;
		await render();
		await advance();
		expect(mocks.place).toHaveBeenCalledTimes(1);
	});

	it("stopping during startup reads prevents placement and leaves unrelated orders alone", async () => {
		mocks.orders = [
			{
				coin: "BTC",
				side: "A",
				oid: 77,
				limitPx: "100",
				sz: "1",
				origSz: "1",
				timestamp: 0,
				reduceOnly: true,
				isTrigger: false,
				triggerPx: "0",
				triggerCondition: "",
				children: [],
				isPositionTpsl: false,
				orderType: "Limit",
				tif: "Alo",
				cloid: null,
			},
		];
		let resolveRead!: (value: unknown[]) => void;
		mocks.info.frontendOpenOrders.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveRead = resolve;
				}),
		);
		await startIntent();
		await act(async () => useChaseOrderStore.getState().actions.clear());
		await act(async () => resolveRead([]));
		expect(mocks.place).not.toHaveBeenCalled();
		expect(mocks.cancel).not.toHaveBeenCalled();
	});

	it("initially small positions use the reduce-only market close path", async () => {
		mocks.position = { szi: "0.05" };
		mocks.place.mockResolvedValue({ response: { data: { statuses: [{ filled: { oid: 90 } }] } } });
		await startIntent();
		expect(mocks.place).toHaveBeenCalledWith({
			orders: [
				expect.objectContaining({
					r: true,
					s: "0.05",
					t: { limit: { tif: "FrontendMarket" } },
				}),
			],
			grouping: "na",
		});
		mocks.position = null;
		await advance();
		expect(useChaseOrderStore.getState().entry).toBeNull();
		expect(useChaseOrderStore.getState().history[0].outcome).toBe("completed");
	});
});

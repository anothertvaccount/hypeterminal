// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OrderLineActions, useOrderLineActions } from "@/hooks/trade/use-order-line-actions";
import type { OpenOrder } from "@/lib/trade/open-orders";
import { orderEvidence } from "@/lib/trade/order-evidence";
import { orderOperationLock } from "@/lib/trade/order-operation-lock";
import { useOrderMoveStore } from "@/stores/use-order-move-store";
import { useTifOverrideStore } from "@/stores/use-tif-override-store";

const mocks = vi.hoisted(() => ({
	modify: vi.fn(),
	cancel: vi.fn(),
	cancelOpen: vi.fn(),
	place: vi.fn(),
	info: vi.fn(),
	frontendOpenOrders: vi.fn(),
	addOrder: vi.fn(),
	sound: vi.fn(),
	notice: vi.fn(),
	paperReprice: vi.fn(),
	paper: false,
}));
vi.mock("@lingui/core/macro", () => ({
	t: (strings: TemplateStringsArray, ...values: unknown[]) =>
		strings.reduce((out, part, i) => out + part + (values[i] ?? ""), ""),
}));
vi.mock("@/config/paper", () => ({
	get PAPER_TRADE() {
		return mocks.paper;
	},
}));
vi.mock("@/lib/hyperliquid", () => ({
	assertExchange: (client: unknown) => {
		if (!client) throw new Error("Missing signer");
	},
	useHyperliquidClients: () => ({ trading: { batchModify: mocks.modify, cancel: mocks.cancel, order: mocks.place } }),
	useHyperliquid: () => ({ info: { orderStatus: mocks.info, frontendOpenOrders: mocks.frontendOpenOrders } }),
	useTradingSession: () => ({ address: "0x0000000000000000000000000000000000000001" }),
	useMarkets: () => ({ getAssetId: () => 0 }),
}));
vi.mock("@/hooks/trade/use-order-evidence", () => ({
	useOrderEvidence: () => ({ scope: "test", updatesReady: () => true }),
}));
vi.mock("@/hooks/trade/use-cancel-open-orders", () => ({ useCancelOpenOrders: () => mocks.cancelOpen }));
vi.mock("@/stores/use-paper-store", () => ({ usePaperActions: () => ({ repriceOrder: mocks.paperReprice }) }));
vi.mock("@/stores/use-order-queue-store", () => ({ useOrderQueueActions: () => ({ addOrder: mocks.addOrder }) }));
vi.mock("@/lib/fill-sound", () => ({ playActionSound: mocks.sound }));
vi.mock("sonner", () => ({ toast: Object.assign(mocks.notice, { error: mocks.notice, success: mocks.notice }) }));
const order: OpenOrder = {
	coin: "BTC",
	side: "B",
	limitPx: "84000",
	sz: "0.02",
	oid: 99,
	timestamp: 0,
	origSz: "0.02",
	triggerCondition: "",
	isTrigger: false,
	triggerPx: "0",
	children: [],
	isPositionTpsl: false,
	reduceOnly: false,
	orderType: "Limit",
	tif: "Alo",
	cloid: null,
};
const snapshot = (row = order, status = "open") => ({ status: "order", order: { status, order: row } });
let actions: OrderLineActions;
let root: Root;
let container: HTMLDivElement;
function Probe() {
	actions = useOrderLineActions();
	return null;
}
function setup(tif: OpenOrder["tif"] = "Gtc", remaining = "0.02") {
	const fresh = { ...order, tif };
	mocks.info
		.mockResolvedValueOnce(snapshot(fresh))
		.mockResolvedValueOnce(snapshot({ ...fresh, sz: remaining }, "canceled"))
		.mockResolvedValue(snapshot({ ...fresh, oid: 100, sz: remaining, limitPx: "83000" }));
	mocks.cancel.mockResolvedValue({ response: { data: { statuses: ["success"] } } });
	mocks.place.mockResolvedValue({ response: { data: { statuses: [{ resting: { oid: 100 } }] } } });
}
async function reprice(row = order, price = 83000) {
	let result = false;
	await act(async () => {
		result = await actions.repriceOrder(row, price);
	});
	return result;
}
beforeEach(() => {
	vi.resetAllMocks();
	orderEvidence.reset();
	orderOperationLock.reset();
	mocks.frontendOpenOrders.mockResolvedValue([]);
	mocks.paper = false;
	// Model the REAL reported bug: batchModify cannot preserve GTC. No ordinary
	// limit test may succeed by pretending this API preserves the desired TIF.
	mocks.modify.mockRejectedValue(new Error("batchModify resets limit TIF to Alo"));
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() => root.render(createElement(Probe)));
});
afterEach(() => {
	act(() => {
		root.unmount();
		const moves = useOrderMoveStore.getState();
		for (const id of Object.keys(moves.moves)) moves.drop(Number(id));
		const state = useTifOverrideStore.getState();
		for (const id of [...Object.keys(state.overrides), ...Object.keys(state.pending), ...Object.keys(state.errors)])
			state.drop(Number(id));
	});
	container.remove();
	vi.useRealTimers();
});
describe("instant chart preview, native Post Only, safe GTC replacement", () => {
	it("blocks duplicate cancel and trigger drag while cancellation is running", async () => {
		let resolveCancel = () => {};
		mocks.cancelOpen.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveCancel = resolve;
				}),
		);
		const trigger: OpenOrder = {
			...order,
			isTrigger: true,
			reduceOnly: true,
			triggerPx: "84000",
			orderType: "Stop Market",
		};
		let cancellation: Promise<void>;
		act(() => {
			cancellation = actions.cancelOrder(trigger);
		});
		await act(async () => {
			await actions.cancelOrder(trigger);
		});
		expect(await reprice(trigger)).toBe(false);
		expect(mocks.cancelOpen).toHaveBeenCalledTimes(1);
		expect(mocks.modify).not.toHaveBeenCalled();
		await act(async () => {
			resolveCancel();
			await cancellation;
		});
	});
	it("preserves GTC despite stale Alo chart data and an exchange that resets modified limits", async () => {
		setup();
		useTifOverrideStore.getState().confirm(99, "Gtc");
		expect(await reprice()).toBe(true);
		expect(mocks.modify).not.toHaveBeenCalled();
		expect(mocks.cancel).toHaveBeenCalledWith({ cancels: [{ a: 0, o: 99 }] });
		expect(mocks.place.mock.calls[0][0].orders[0]).toMatchObject({
			a: 0,
			b: true,
			p: "83000",
			s: "0.02",
			r: false,
			t: { limit: { tif: "Gtc" } },
		});
		expect(useTifOverrideStore.getState().overrides[100]).toBe("Gtc");
		expect(mocks.info).toHaveBeenLastCalledWith(
			{ user: "0x0000000000000000000000000000000000000001", oid: 100 },
			expect.any(AbortSignal),
		);
	});
	it("does not rely on an override still being present", async () => {
		setup();
		const store = useTifOverrideStore.getState();
		store.confirm(99, "Gtc");
		store.clearIfAgrees(99, "Gtc");
		expect(useTifOverrideStore.getState().overrides[99]).toBeUndefined();
		expect(await reprice()).toBe(true);
		expect(mocks.place.mock.calls[0][0].orders[0].t.limit.tif).toBe("Gtc");
	});
	it("uses speedy native modification for VERIFIED Post Only, even if raw row says GTC", async () => {
		mocks.info
			.mockResolvedValueOnce(snapshot(order))
			.mockResolvedValue(snapshot({ ...order, oid: 100, limitPx: "83000" }));
		mocks.modify.mockResolvedValue({ response: { data: { statuses: [{ resting: { oid: 100 } }] } } });
		expect(await reprice({ ...order, tif: "Gtc" })).toBe(true);
		expect(mocks.modify.mock.calls[0][0].modifies[0].order.t.limit.tif).toBe("Alo");
		expect(mocks.cancel).not.toHaveBeenCalled();
		expect(mocks.place).not.toHaveBeenCalled();
	});
	it("shows a target-price placeholder synchronously, before preflight returns, for GTC too", async () => {
		let resolve!: (value: unknown) => void;
		mocks.info.mockImplementation(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		let job!: Promise<boolean>;
		act(() => {
			job = actions.repriceOrder({ ...order, tif: "Gtc" }, 83000);
		});
		expect(useOrderMoveStore.getState().moves[99]).toMatchObject({
			pending: true,
			order: { limitPx: "83000", tif: "Gtc" },
		});
		await act(async () => {
			resolve({ status: "unknownOid" });
			await job;
		});
		expect(useOrderMoveStore.getState().moves[99]).toBeUndefined();
	});
	it("retries a transient cancellation-read error, never the cancel or placement writes", async () => {
		setup();
		mocks.info
			.mockReset()
			.mockResolvedValueOnce(snapshot({ ...order, tif: "Gtc" }))
			.mockRejectedValueOnce(new Error("temporary info timeout"))
			.mockResolvedValueOnce(snapshot({ ...order, tif: "Gtc" }, "canceled"))
			.mockResolvedValue(snapshot({ ...order, oid: 100, tif: "Gtc", limitPx: "83000" }));
		expect(await reprice()).toBe(true);
		expect(mocks.cancel).toHaveBeenCalledTimes(1);
		expect(mocks.place).toHaveBeenCalledTimes(1);
	});
	it("reposts only the FINAL quantity after a partial fill during cancel, with fresh cloid", async () => {
		setup("Gtc", "0.01");
		expect(await reprice()).toBe(true);
		const row = mocks.place.mock.calls[0][0].orders[0];
		expect(row.s).toBe("0.01");
		expect(row.c).toMatch(/^0x[0-9a-f]{32}$/);
	});
	it("does not drag an order mid-replacement", async () => {
		useTifOverrideStore.getState().setOverride(99, "Gtc");
		expect(await reprice()).toBe(false);
		expect(mocks.cancel).not.toHaveBeenCalled();
		expect(mocks.info).not.toHaveBeenCalled();
	});
	it("checks the lock after the asynchronous preflight", async () => {
		mocks.info.mockImplementation(async () => {
			useTifOverrideStore.getState().setOverride(99, "Gtc");
			return snapshot({ ...order, tif: "Gtc" });
		});
		expect(await reprice()).toBe(false);
		expect(mocks.cancel).not.toHaveBeenCalled();
	});
	it.each(["canceled", "filled"])("does not reprice a stale %s oid", async (status) => {
		mocks.info.mockResolvedValue(snapshot(order, status));
		expect(await reprice()).toBe(false);
		expect(mocks.cancel).not.toHaveBeenCalled();
	});
	it("never guesses GTC when TIF is unknown", async () => {
		mocks.info.mockResolvedValue(snapshot({ ...order, tif: null }));
		expect(await reprice()).toBe(false);
		expect(mocks.cancel).not.toHaveBeenCalled();
	});
	it("rejects a changed order identity", async () => {
		mocks.info.mockResolvedValue(snapshot({ ...order, side: "A" }));
		expect(await reprice()).toBe(false);
		expect(mocks.cancel).not.toHaveBeenCalled();
	});
	it("refuses attached protective TP/SL rather than canceling them", async () => {
		mocks.info.mockResolvedValue(snapshot({ ...order, tif: "Gtc", children: [order] }));
		expect(await reprice()).toBe(false);
		expect(mocks.cancel).not.toHaveBeenCalled();
	});
	it("never posts after a rejected cancellation", async () => {
		setup();
		mocks.cancel.mockResolvedValue({ response: { data: { statuses: [{ error: "Cancel rejected" }] } } });
		expect(await reprice()).toBe(false);
		expect(mocks.place).not.toHaveBeenCalled();
		expect(mocks.sound).not.toHaveBeenCalled();
	});
	it("never posts before authoritative cancellation read-back", async () => {
		vi.useFakeTimers();
		mocks.info.mockResolvedValue(snapshot({ ...order, tif: "Gtc" }));
		mocks.cancel.mockResolvedValue({ response: { data: { statuses: ["success"] } } });
		let result: boolean | undefined;
		await act(async () => {
			const job = actions.repriceOrder(order, 83000).then((r) => {
				result = r;
			});
			await vi.runAllTimersAsync();
			await job;
		});
		expect(result).toBe(false);
		expect(mocks.place).not.toHaveBeenCalled();
	});
	it("does not recreate units filled during cancellation", async () => {
		setup();
		mocks.info
			.mockReset()
			.mockResolvedValueOnce(snapshot({ ...order, tif: "Gtc" }))
			.mockResolvedValueOnce(snapshot({ ...order, tif: "Gtc" }))
			.mockResolvedValue(snapshot(order, "filled"));
		expect(await reprice()).toBe(true);
		expect(mocks.place).not.toHaveBeenCalled();
	});
	it("does not mask a wrong-TIF resting replacement", async () => {
		vi.useFakeTimers();
		setup();
		mocks.info
			.mockReset()
			.mockResolvedValueOnce(snapshot({ ...order, tif: "Gtc" }))
			.mockResolvedValueOnce(snapshot({ ...order, tif: "Gtc" }))
			.mockResolvedValueOnce(snapshot(order, "canceled"))
			.mockResolvedValue(snapshot({ ...order, oid: 100, limitPx: "83000" }));
		let result: boolean | undefined;
		await act(async () => {
			const job = actions.repriceOrder(order, 83000).then((r) => {
				result = r;
			});
			await vi.runAllTimersAsync();
			await job;
		});
		expect(result).toBe(false);
		expect(mocks.sound).not.toHaveBeenCalled();
		expect(mocks.place).toHaveBeenCalledTimes(1);
		expect(useTifOverrideStore.getState().errors[100]).toContain("Reprice not confirmed");
		expect(mocks.addOrder.mock.calls[0][0].error).toContain("Original order canceled");
	});
	it("never automatically retries a failed placement after cancel", async () => {
		setup();
		mocks.place.mockRejectedValue(new Error("lost response"));
		expect(await reprice()).toBe(false);
		expect(mocks.place).toHaveBeenCalledTimes(1);
		expect(mocks.addOrder.mock.calls[0][0]).toMatchObject({ price: "83000", status: "failed" });
		expect(useOrderMoveStore.getState().moves[99]).toMatchObject({
			pending: false,
			error: expect.stringContaining("lost response"),
			order: { limitPx: "83000" },
		});
		expect(useOrderMoveStore.getState().isMoving(99)).toBe(true);
		expect(await reprice()).toBe(false);
		expect(mocks.place).toHaveBeenCalledTimes(1);
	});
	it("handles a replacement that fills rather than rests", async () => {
		setup();
		mocks.place.mockResolvedValue({
			response: { data: { statuses: [{ filled: { oid: 100, totalSz: "0.02", avgPx: "83000" } }] } },
		});
		expect(await reprice()).toBe(true);
		expect(mocks.sound).toHaveBeenCalledOnce();
	});
	it("keeps specialized trigger batchModify, including nested error validation", async () => {
		const trigger: OpenOrder = {
			...order,
			isTrigger: true,
			orderType: "Stop Market",
			triggerPx: "84000",
			reduceOnly: true,
			side: "A" as const,
		};
		mocks.modify
			.mockResolvedValueOnce({ response: { data: { statuses: ["waitingForTrigger"] } } })
			.mockResolvedValueOnce({ response: { data: { statuses: [{ error: "Modify rejected" }] } } });
		expect(await reprice(trigger)).toBe(true);
		expect(mocks.modify.mock.calls[0][0].modifies[0].order.t).toEqual({
			trigger: { isMarket: true, triggerPx: "83000", tpsl: "sl" },
		});
		expect(await reprice(trigger)).toBe(false);
		expect(mocks.info).not.toHaveBeenCalled();
		expect(mocks.cancel).not.toHaveBeenCalled();
	});
	it("keeps paper repricing entirely local", async () => {
		mocks.paper = true;
		expect(await reprice()).toBe(true);
		expect(mocks.paperReprice).toHaveBeenCalledWith(99, 83000);
		expect(mocks.cancel).not.toHaveBeenCalled();
		expect(mocks.place).not.toHaveBeenCalled();
	});
});

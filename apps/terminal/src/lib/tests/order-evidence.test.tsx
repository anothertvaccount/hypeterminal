// @vitest-environment jsdom
import type { OrderUpdatesWsEvent } from "@nktkas/hyperliquid";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOrderEvidence } from "@/hooks/trade/use-order-evidence";
import { orderUpdateRow } from "@/lib/tests/order-update-fixture";
import type { OpenOrder } from "@/lib/trade/open-orders";
import {
	cancellationEvidence,
	matchingRestingOrder,
	orderEvidence,
	orderEvidenceScope,
	readCurrentOpenOrder,
} from "@/lib/trade/order-evidence";

const mocks = vi.hoisted(() => {
	const subscriptions: Record<string, { status: string; data?: unknown }> = {};
	const listeners = new Set<() => void>();
	return {
		subscriptions,
		listeners,
		info: { orderStatus: vi.fn(), frontendOpenOrders: vi.fn() },
		store: {
			getState: () => ({ subscriptions }),
			subscribe: (listener: () => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
	};
});
const owner = "0x0000000000000000000000000000000000000001" as const;
vi.mock("@/config/paper", () => ({ PAPER_TRADE: false }));
vi.mock("@/lib/hyperliquid", () => ({
	useHyperliquid: () => ({ info: mocks.info }),
	useTradingSession: () => ({ address: owner }),
	useSubscription: vi.fn(),
	useHyperliquidStoreApi: () => mocks.store,
	subscriptionKeys: { method: (method: string) => [method] },
	serializeKey: (key: string[]) => key[0],
}));
const order: OpenOrder = {
	oid: 42,
	coin: "BTC",
	side: "B",
	limitPx: "84000",
	sz: "0.02",
	origSz: "0.02",
	timestamp: 1,
	tif: "Gtc",
	reduceOnly: false,
	isTrigger: false,
	triggerPx: "0",
	triggerCondition: "",
	children: [],
	isPositionTpsl: false,
	orderType: "Limit",
	cloid: "0x11111111111111111111111111111111",
};
const event = (status: OrderUpdatesWsEvent[number]["status"], timestamp: number, row = order): OrderUpdatesWsEvent => [
	{ order: orderUpdateRow(row), status, statusTimestamp: timestamp },
];
beforeEach(() => {
	orderEvidence.reset();
	vi.resetAllMocks();
	for (const key of Object.keys(mocks.subscriptions)) delete mocks.subscriptions[key];
	mocks.listeners.clear();
});
afterEach(() => vi.useRealTimers());

describe("scoped authoritative order evidence", () => {
	it("keeps terminal evidence over delayed open updates and deduplicates batches", () => {
		const scope = orderEvidenceScope(mocks.info, owner);
		const cursor = orderEvidence.cursor();
		const batch = event("canceled", 20, { ...order, sz: "0.015" });
		orderEvidence.ingestUpdates(scope, batch);
		const revision = orderEvidence.cursor();
		orderEvidence.ingestUpdates(scope, batch);
		expect(orderEvidence.cursor()).toBe(revision);
		orderEvidence.ingestUpdates(scope, event("open", 10));
		orderEvidence.ingestUpdates(scope, event("open", 30));
		orderEvidence.ingestOpen(scope, [order]);
		expect(orderEvidence.open(scope, 42)).toBeUndefined();
		expect(cancellationEvidence(scope, order, cursor)?.order.sz).toBe("0.015");
	});
	it("does not use pre-cursor, other owner, or other network cancellation evidence", () => {
		const scope = orderEvidenceScope(mocks.info, owner);
		orderEvidence.ingestUpdates(scope, event("canceled", 20));
		expect(cancellationEvidence(scope, order, orderEvidence.cursor())).toBeUndefined();
		expect(cancellationEvidence(orderEvidenceScope({}, owner), order, 0)).toBeUndefined();
		expect(cancellationEvidence(orderEvidenceScope(mocks.info, "0x2"), order, 0)).toBeUndefined();
		expect(orderEvidenceScope(mocks.info, owner.toUpperCase())).toBe(scope);
	});
	it.each([
		{ side: "A" as const },
		{ coin: "ETH" },
		{ limitPx: "85000" },
		{ cloid: "0x22222222222222222222222222222222" },
		{ reduceOnly: true },
	] as const)("rejects mismatched cancellation metadata %j", (patch) => {
		orderEvidence.ingestUpdates("test", event("canceled", 20, { ...order, ...patch }));
		expect(cancellationEvidence("test", order, 0)).toBeUndefined();
	});
	it.each([
		{ tif: "Alo" as const },
		{ side: "A" as const },
		{ limitPx: "85000" },
		{ cloid: "0x22222222222222222222222222222222" },
		{ sz: "0.03" },
		{ sz: "0" },
		{ reduceOnly: true },
	] as const)("rejects a replacement mismatch %j", (patch) => {
		expect(matchingRestingOrder({ ...order, ...patch }, order, "Gtc", "84000", "0.02", order.cloid ?? undefined)).toBe(
			false,
		);
	});
	it("falls back from unknown history to an independent current book", async () => {
		mocks.info.orderStatus.mockResolvedValue({ status: "unknownOid" });
		mocks.info.frontendOpenOrders.mockResolvedValue([order]);
		expect(await readCurrentOpenOrder(mocks.info as never, owner, 42, "BTC", "test")).toEqual(order);
	});
	it("cannot override a cancellation arriving during fallback with stale open data", async () => {
		mocks.info.orderStatus.mockResolvedValue({ status: "unknownOid" });
		mocks.info.frontendOpenOrders.mockImplementation(async () => {
			orderEvidence.ingestUpdates("test", event("canceled", 20));
			return [order];
		});
		await expect(readCurrentOpenOrder(mocks.info as never, owner, 42, "BTC", "test")).rejects.toThrow("no longer open");
	});
	it("does not use a cached row or HTTP terminal history as an open preflight", async () => {
		orderEvidence.ingestOpen("test", [order]);
		mocks.info.orderStatus.mockResolvedValue({ status: "order", order: { order, status: "filled" } });
		mocks.info.frontendOpenOrders.mockResolvedValue([order]);
		await expect(readCurrentOpenOrder(mocks.info as never, owner, 42, "BTC", "test")).rejects.toThrow("no longer open");
		expect(mocks.info.frontendOpenOrders).not.toHaveBeenCalled();
	});
});

describe("evidence subscription lifecycle", () => {
	it("captures intermediate batches and reads current readiness without rerendering", () => {
		const container = document.createElement("div");
		const root = createRoot(container);
		let evidence!: ReturnType<typeof useOrderEvidence>;
		function Probe() {
			evidence = useOrderEvidence();
			return null;
		}
		act(() => root.render(createElement(Probe)));
		try {
			const deliver = (data: OrderUpdatesWsEvent, status = "active") => {
				mocks.subscriptions.orderUpdates = { status, data };
				for (const listener of mocks.listeners) listener();
			};
			const cursor = orderEvidence.cursor();
			act(() => {
				deliver(event("canceled", 20, { ...order, sz: "0.015" }));
				deliver(event("open", 21, { ...order, oid: 99 }));
			});
			expect(cancellationEvidence(evidence.scope, order, cursor)?.order.sz).toBe("0.015");
			expect(evidence.updatesReady()).toBe(true);
			deliver([], "error");
			expect(evidence.updatesReady()).toBe(false);
		} finally {
			act(() => root.unmount());
		}
		expect(mocks.listeners.size).toBe(0);
	});
});

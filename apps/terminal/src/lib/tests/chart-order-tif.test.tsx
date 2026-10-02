// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderTifControl } from "@/components/trade/chart/tradingview/order-tif-control";
import { OrderTifStatus } from "@/components/trade/positions/order-tif-status";
import { tifLabel } from "@/domain/trade/order/time-in-force";
import { orderUpdateRow } from "@/lib/tests/order-update-fixture";
import type { OpenOrder } from "@/lib/trade/open-orders";
import { orderEvidence } from "@/lib/trade/order-evidence";
import { orderOperationLock } from "@/lib/trade/order-operation-lock";
import { matchesReplacement } from "@/lib/trade/tpsl-conversion";
import { mergeChartOrderMoves, useOrderMoveStore } from "@/stores/use-order-move-store";
import { useTifOverrideStore } from "@/stores/use-tif-override-store";
import { findTpSlOrigin, tpSlScope, useTpSlOriginStore } from "@/stores/use-tpsl-origin-store";

const mocks = vi.hoisted(() => ({
	cancel: vi.fn(),
	place: vi.fn(),
	orderStatus: vi.fn(),
	frontendOpenOrders: vi.fn(),
	clearinghouseState: vi.fn(),
	updatesReady: true,
	addOrder: vi.fn(),
	error: vi.fn(),
	success: vi.fn(),
	notice: vi.fn(),
}));
vi.mock("@lingui/core/macro", () => ({
	t: (strings: TemplateStringsArray, ...values: unknown[]) =>
		strings.reduce((message, part, index) => `${message}${part}${values[index] ?? ""}`, ""),
}));
vi.mock("@/config/paper", () => ({ PAPER_TRADE: false }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/lib/hyperliquid", () => ({
	assertExchange: (client: unknown) => {
		if (!client) throw new Error("Missing signer");
	},
	useHyperliquidClients: () => ({ trading: { cancel: mocks.cancel, order: mocks.place } }),
	useMarkets: () => ({ getAssetId: () => 0 }),
	useHyperliquid: () => ({
		info: {
			orderStatus: mocks.orderStatus,
			frontendOpenOrders: mocks.frontendOpenOrders,
			clearinghouseState: mocks.clearinghouseState,
		},
	}),
	useTradingSession: () => ({ address: "0x0000000000000000000000000000000000000001" }),
}));
vi.mock("@/hooks/trade/use-order-evidence", () => ({
	useOrderEvidence: () => ({ scope: "test", updatesReady: () => mocks.updatesReady }),
}));
vi.mock("@/stores/use-paper-store", () => ({ usePaperActions: () => ({ setRestingTif: vi.fn() }) }));
vi.mock("@/stores/use-order-queue-store", () => ({ useOrderQueueActions: () => ({ addOrder: mocks.addOrder }) }));
vi.mock("sonner", () => ({ toast: Object.assign(mocks.notice, { error: mocks.error, success: mocks.success }) }));

const order: OpenOrder = {
	coin: "BTC",
	side: "B",
	limitPx: "84000",
	sz: "0.02",
	oid: 42,
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
const snapshot = (status: string, row = order) => ({ status: "order", order: { status, order: row } });
const cancelOk = { response: { data: { statuses: ["success"] } } };
const resting = { response: { data: { statuses: [{ resting: { oid: 99 } }] } } };

let root: Root;
let container: HTMLDivElement;
const rowPointerDown = vi.fn();
function render(row = order, key = "row") {
	act(() =>
		root.render(
			createElement("div", { onPointerDown: rowPointerDown }, createElement(OrderTifControl, { order: row, key })),
		),
	);
}
function press(element: Element | null) {
	if (!element) throw new Error("Missing control");
	act(() => {
		element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
		element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
		element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}
const chip = () => container.querySelector<HTMLButtonElement>('button[aria-label="Change order type"]');
function pick(label = "GTC") {
	press(chip());
	const choices = [...document.querySelectorAll('[role="menuitem"]')];
	expect(choices.map((item) => item.textContent)).toEqual(["Post Only", "GTC"]);
	press(choices.find((item) => item.textContent === label) ?? null);
}
async function flush() {
	await act(async () => {});
}
function setupRepost(actual = "Gtc", remaining = "0.02") {
	mocks.cancel.mockResolvedValue(cancelOk);
	mocks.place.mockResolvedValue(resting);
	mocks.orderStatus
		.mockResolvedValueOnce(snapshot("open"))
		.mockResolvedValueOnce(snapshot("canceled", { ...order, sz: remaining }))
		.mockResolvedValue(snapshot("open", { ...order, oid: 99, sz: remaining, tif: actual as OpenOrder["tif"] }));
}

beforeEach(() => {
	vi.clearAllMocks();
	orderEvidence.reset();
	orderOperationLock.reset();
	useTpSlOriginStore.setState({ origins: {} });
	mocks.clearinghouseState
		.mockReset()
		.mockResolvedValue({ assetPositions: [{ position: { coin: "BTC", szi: "0.02" } }] });
	mocks.updatesReady = true;
	mocks.frontendOpenOrders.mockReset().mockResolvedValue([]);
	mocks.cancel.mockReset().mockImplementation(() => new Promise(() => {}));
	mocks.place.mockReset().mockImplementation(() => new Promise(() => {}));
	mocks.orderStatus.mockReset().mockResolvedValue(snapshot("open"));
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => {
		root.unmount();
		const state = useTifOverrideStore.getState();
		for (const oid of new Set([
			...Object.keys(state.overrides),
			...Object.keys(state.errors),
			...Object.keys(state.pending),
		]))
			state.drop(Number(oid));
	});
	container.remove();
	for (const oid of Object.keys(useOrderMoveStore.getState().moves)) useOrderMoveStore.getState().drop(Number(oid));
	vi.useRealTimers();
});

const trigger: OpenOrder = {
	...order,
	side: "A",
	reduceOnly: true,
	isTrigger: true,
	isPositionTpsl: true,
	orderType: "Take Profit Market",
	limitPx: "90000",
	triggerPx: "90000",
	tif: null,
};
function pickTpSl(label: string) {
	press(chip());
	const choices = [...document.querySelectorAll('[role="menuitem"]')];
	expect(choices.map((item) => item.textContent)).toEqual(["Post Only", "GTC", "Trigger Market"]);
	press(choices.find((item) => item.textContent === label) ?? null);
}
function conversion(source: OpenOrder, mode: "Gtc" | "Alo" | "TriggerMarket", remaining = source.sz, oid = 99) {
	let target: OpenOrder;
	mocks.cancel.mockResolvedValue(cancelOk);
	mocks.place.mockImplementation(async ({ orders }) => {
		const sent = orders[0];
		target = {
			...source,
			oid,
			cloid: sent.c,
			limitPx: sent.p,
			sz: sent.s,
			origSz: sent.s,
			isTrigger: mode === "TriggerMarket",
			triggerPx: mode === "TriggerMarket" ? sent.p : "0",
			isPositionTpsl: mode === "TriggerMarket" && source.isPositionTpsl,
			orderType: mode === "TriggerMarket" ? "Take Profit Market" : "Limit",
			tif: mode === "TriggerMarket" ? null : mode,
		};
		return { response: { data: { statuses: [{ resting: { oid } }] } } };
	});
	mocks.orderStatus
		.mockReset()
		.mockResolvedValueOnce(snapshot("open", source))
		.mockResolvedValueOnce(snapshot("canceled", { ...source, sz: remaining }))
		.mockImplementation(async () => snapshot("open", target));
	return () => target;
}

describe("TP/SL execution conversion", () => {
	it("blocks a mode change while another chart operation owns the order", async () => {
		const scope = tpSlScope("0x0000000000000000000000000000000000000001");
		const lock = orderOperationLock.acquire(scope, trigger.oid);
		render(trigger);
		pickTpSl("GTC");
		await flush();
		expect(mocks.cancel).not.toHaveBeenCalled();
		expect(mocks.place).not.toHaveBeenCalled();
		if (lock) orderOperationLock.release(scope, trigger.oid, lock);
	});

	it("does not verify restored protection with an oversized original or full-position quantity", () => {
		const cloid = "0xabc";
		const expected: OpenOrder = { ...trigger, cloid, sz: "0.01", origSz: "0.01" };
		expect(matchesReplacement({ ...expected, origSz: "0.02" }, expected, "TriggerMarket", "0.01", cloid)).toBe(false);
		const full = { ...expected, sz: "0", origSz: "0" };
		expect(matchesReplacement({ ...full, sz: "0.03" }, full, "TriggerMarket", "0", cloid, 0.02)).toBe(false);
		expect(matchesReplacement({ ...full, sz: "0.02" }, full, "TriggerMarket", "0", cloid, 0.02)).toBe(true);
	});
	it.each(["Take Profit Market", "Stop Market"] as const)(
		"converts %s to an active reduce-only limit",
		async (orderType) => {
			const source = { ...trigger, orderType };
			const mode = orderType === "Stop Market" ? "Gtc" : "Alo";
			conversion(source, mode, "0.015");
			render(source);
			pickTpSl(mode === "Alo" ? "Post Only" : "GTC");
			await flush();
			expect(mocks.cancel).toHaveBeenCalledTimes(1);
			expect(mocks.place).toHaveBeenCalledTimes(1);
			expect(mocks.place.mock.calls[0][0]).toMatchObject({
				grouping: "na",
				orders: [{ b: false, p: "90000", s: "0.015", r: true, t: { limit: { tif: mode } } }],
			});
			expect(mocks.success).toHaveBeenCalled();
		},
	);

	it("restores trigger market after a new ID and persisted-state reload", async () => {
		const target = conversion(trigger, "Gtc", "0.015");
		render(trigger);
		pickTpSl("GTC");
		await flush();
		const row = target();
		const savedJson = localStorage.getItem("hypeterminal-tpsl-origins");
		if (!savedJson) throw new Error("Missing persisted origin");
		useTpSlOriginStore.setState({ origins: {} });
		// Zustand writes on setState; restore the actual saved bytes as a fresh instance would see them.
		localStorage.setItem("hypeterminal-tpsl-origins", savedJson);
		await act(async () => useTpSlOriginStore.persist.rehydrate());
		conversion(row, "TriggerMarket", "0.01", 101);
		mocks.place.mockImplementation(async ({ orders }) => {
			const sent = orders[0];
			mocks.orderStatus.mockResolvedValue(
				snapshot("open", { ...trigger, oid: 101, cloid: sent.c, sz: "0.01", origSz: "0.01" }),
			);
			return { response: { data: { statuses: [{ resting: { oid: 101 } }] } } };
		});
		render(row);
		pickTpSl("Trigger Market");
		await flush();
		expect(mocks.place.mock.calls.at(-1)?.[0]).toMatchObject({
			grouping: "positionTpsl",
			orders: [{ s: "0.01", r: true, p: "90000", t: { trigger: { isMarket: true, triggerPx: "90000", tpsl: "tp" } } }],
		});
		expect(mocks.error).not.toHaveBeenCalled();
	});

	it("uses bounded current position quantity for zero-size full-position protection", async () => {
		const source = { ...trigger, sz: "0", origSz: "0" };
		mocks.clearinghouseState
			.mockResolvedValueOnce({ assetPositions: [{ position: { coin: "BTC", szi: "0.02" } }] })
			.mockResolvedValueOnce({ assetPositions: [{ position: { coin: "BTC", szi: "0.012" } }] });
		const target = conversion(source, "Gtc");
		render(source);
		pickTpSl("GTC");
		await flush();
		expect(mocks.place.mock.calls[0][0].orders[0].s).toBe("0.012");
		expect(findTpSlOrigin(target(), tpSlScope("0x0000000000000000000000000000000000000001"))?.fullPosition).toBe(true);
	});

	it("leaves a full-position trigger untouched when the position side cannot be verified", async () => {
		mocks.clearinghouseState.mockResolvedValue({ assetPositions: [{ position: { coin: "BTC", szi: "-0.02" } }] });
		const source = { ...trigger, sz: "0", origSz: "0" };
		conversion(source, "Gtc");
		render(source);
		pickTpSl("GTC");
		await flush();
		expect(mocks.cancel).not.toHaveBeenCalled();
		expect(mocks.place).not.toHaveBeenCalled();
	});

	it("restores full-position SL as a zero-size market trigger with its original grouping", async () => {
		const scope = tpSlScope("0x0000000000000000000000000000000000000001");
		const source = { ...order, side: "A" as const, reduceOnly: true, tif: "Gtc" as const };
		useTpSlOriginStore.getState().remember(
			{
				scope,
				oid: source.oid,
				coin: source.coin,
				side: source.side,
				cloid: null,
				tpsl: "sl",
				fullPosition: true,
				positionTpsl: true,
			},
			source,
		);
		conversion(source, "TriggerMarket", "0.01");
		mocks.place.mockImplementation(async ({ orders }) => {
			const sent = orders[0];
			mocks.orderStatus.mockResolvedValue(
				snapshot("open", {
					...trigger,
					oid: 99,
					cloid: sent.c,
					limitPx: source.limitPx,
					triggerPx: source.limitPx,
					orderType: "Stop Market",
					sz: "0",
					origSz: "0",
				}),
			);
			return resting;
		});
		render(source);
		pickTpSl("Trigger Market");
		await flush();
		expect(mocks.place).toHaveBeenCalledTimes(1);
		expect(mocks.place.mock.calls[0][0]).toMatchObject({
			grouping: "positionTpsl",
			orders: [{ s: "0", r: true, t: { trigger: { isMarket: true, triggerPx: source.limitPx, tpsl: "sl" } } }],
		});
		expect(mocks.error).not.toHaveBeenCalled();
	});

	it("requires matching trigger execution in cancellation evidence", async () => {
		conversion(trigger, "Gtc");
		mocks.orderStatus
			.mockReset()
			.mockResolvedValueOnce(snapshot("open", trigger))
			.mockResolvedValueOnce(snapshot("canceled", { ...trigger, orderType: "Stop Market" }));
		render(trigger);
		pickTpSl("GTC");
		await flush();
		expect(mocks.place).not.toHaveBeenCalled();
	});

	it("uses stream cancellation quantity for TP/SL when order history lags", async () => {
		conversion(trigger, "Alo");
		mocks.cancel.mockImplementation(async () => {
			orderEvidence.ingestUpdates("test", [
				{ order: orderUpdateRow({ ...trigger, sz: "0.014" }), status: "canceled", statusTimestamp: 1 },
			]);
			return cancelOk;
		});
		mocks.orderStatus.mockReset().mockResolvedValueOnce(snapshot("open", trigger));
		mocks.place.mockImplementation(async ({ orders }) => {
			const sent = orders[0];
			mocks.orderStatus.mockResolvedValue(
				snapshot("open", {
					...order,
					oid: 99,
					side: "A",
					reduceOnly: true,
					limitPx: "90000",
					cloid: sent.c,
					sz: "0.014",
				}),
			);
			return resting;
		});
		render(trigger);
		pickTpSl("Post Only");
		await flush();
		expect(mocks.place.mock.calls[0][0].orders[0].s).toBe("0.014");
		expect(mocks.error).not.toHaveBeenCalled();
	});

	it("keeps an entry-linked TP/SL untouched", async () => {
		conversion(trigger, "Gtc");
		mocks.frontendOpenOrders.mockResolvedValue([{ ...order, children: [trigger] }]);
		render(trigger);
		pickTpSl("GTC");
		await flush();
		expect(mocks.cancel).not.toHaveBeenCalled();
		expect(mocks.place).not.toHaveBeenCalled();
	});

	it("never reposts a trigger that filled during cancellation", async () => {
		conversion(trigger, "Gtc");
		mocks.orderStatus
			.mockReset()
			.mockResolvedValueOnce(snapshot("open", trigger))
			.mockResolvedValueOnce(snapshot("filled", { ...trigger, sz: "0" }));
		render(trigger);
		pickTpSl("GTC");
		await flush();
		expect(mocks.place).not.toHaveBeenCalled();
	});

	it("does not retry or restore protection automatically after PO rejection", async () => {
		conversion(trigger, "Alo");
		mocks.place.mockResolvedValue({ response: { data: { statuses: [{ error: "Post only order would cross" }] } } });
		render(trigger);
		pickTpSl("Post Only");
		await flush();
		expect(mocks.place).toHaveBeenCalledTimes(1);
		expect(mocks.error.mock.calls.at(-1)?.[0]).toContain("Original order canceled");
	});

	it("ignores saved intent from another owner/network or mismatched CLOID", async () => {
		const row: OpenOrder = { ...order, reduceOnly: true, cloid: "0xabc" };
		const scope = tpSlScope("0x0000000000000000000000000000000000000001");
		useTpSlOriginStore.getState().remember(
			{
				scope: `${scope}-other`,
				oid: row.oid,
				coin: row.coin,
				side: row.side,
				cloid: row.cloid,
				tpsl: "sl",
				fullPosition: false,
				positionTpsl: true,
			},
			row,
		);
		expect(findTpSlOrigin(row, scope)).toBeUndefined();
		useTpSlOriginStore.getState().remember(
			{
				scope,
				oid: row.oid,
				coin: row.coin,
				side: row.side,
				cloid: row.cloid,
				tpsl: "sl",
				fullPosition: false,
				positionTpsl: true,
			},
			row,
		);
		expect(findTpSlOrigin({ ...row, cloid: "0xdef" }, scope)).toBeUndefined();
		expect(findTpSlOrigin({ ...row, cloid: null }, scope)?.tpsl).toBe("sl");
		expect(findTpSlOrigin({ ...row, oid: 43 }, scope)?.tpsl).toBe("sl");
	});
});

describe("on-chart TIF cancel/repost", () => {
	it("rechecks subscription readiness after the asynchronous preflight", async () => {
		mocks.orderStatus.mockImplementation(async () => {
			mocks.updatesReady = false;
			return snapshot("open");
		});
		render();
		pick();
		await flush();
		expect(mocks.cancel).not.toHaveBeenCalled();
		expect(chip()?.title).toContain("stream is not ready");
	});

	it("uses stream-only cancellation quantity when history remains unknown and verifies the frontend book", async () => {
		mocks.orderStatus.mockResolvedValueOnce(snapshot("open")).mockResolvedValue({ status: "unknownOid" });
		mocks.cancel.mockImplementation(async () => {
			orderEvidence.ingestUpdates("test", [
				{ order: orderUpdateRow({ ...order, sz: "0.015" }), status: "canceled", statusTimestamp: 1 },
			]);
			return cancelOk;
		});
		mocks.place.mockResolvedValue(resting);
		mocks.frontendOpenOrders.mockResolvedValue([{ ...order, oid: 99, sz: "0.015", tif: "Gtc" }]);
		render();
		pick();
		await flush();
		expect(mocks.place).toHaveBeenCalledTimes(1);
		expect(mocks.place.mock.calls[0][0].orders[0].s).toBe("0.015");
		expect(mocks.success).toHaveBeenCalledWith("BTC order #99 confirmed GTC by exchange");
	});

	it("never reposts a stream-only full fill while history stays open", async () => {
		mocks.cancel.mockImplementation(async () => {
			orderEvidence.ingestUpdates("test", [
				{ order: orderUpdateRow({ ...order, sz: "0" }), status: "filled", statusTimestamp: 1 },
			]);
			return cancelOk;
		});
		render();
		pick();
		await flush();
		expect(mocks.place).not.toHaveBeenCalled();
		expect(mocks.notice).toHaveBeenCalledWith("BTC order filled during cancellation. Nothing reposted.");
	});

	it.each(["filled", "canceled"] as const)(
		"a %s event during HTTP read beats a stale replacement open response",
		async (status) => {
			setupRepost();
			mocks.orderStatus
				.mockReset()
				.mockResolvedValueOnce(snapshot("open"))
				.mockResolvedValueOnce(snapshot("canceled"))
				.mockImplementation(async () => {
					const row = { ...order, oid: 99, tif: "Gtc" as const, cloid: mocks.place.mock.calls[0][0].orders[0].c };
					orderEvidence.ingestUpdates("test", [{ order: orderUpdateRow(row), status, statusTimestamp: 2 }]);
					return snapshot("open", row);
				});
			render();
			pick();
			await flush();
			expect(mocks.place).toHaveBeenCalledTimes(1);
			expect(mocks.success).not.toHaveBeenCalledWith("BTC order #99 confirmed GTC by exchange");
			if (status === "filled") expect(mocks.success).toHaveBeenCalledWith("BTC replacement order filled");
			else
				expect(mocks.error).toHaveBeenCalledWith(
					expect.stringContaining("exchange reports canceled"),
					expect.anything(),
				);
		},
	);

	it("does not let a stale frontend book override terminal HTTP history", async () => {
		setupRepost();
		mocks.orderStatus
			.mockReset()
			.mockResolvedValueOnce(snapshot("open"))
			.mockResolvedValueOnce(snapshot("canceled"))
			.mockResolvedValue(snapshot("canceled", { ...order, oid: 99, tif: "Gtc" }));
		mocks.frontendOpenOrders.mockResolvedValue([{ ...order, oid: 99, tif: "Gtc" }]);
		render();
		pick();
		await flush();
		expect(mocks.success).not.toHaveBeenCalled();
		expect(mocks.frontendOpenOrders).not.toHaveBeenCalled();
	});

	it("confirms from the live book when orderStatus is unavailable", async () => {
		setupRepost();
		mocks.place.mockImplementation(async () => {
			orderEvidence.ingestOpen("test", [{ ...order, oid: 99, tif: "Gtc" }]);
			return resting;
		});
		render();
		pick();
		await flush();
		expect(mocks.orderStatus).toHaveBeenCalledTimes(2);
		expect(mocks.success).toHaveBeenCalledWith("BTC order #99 confirmed GTC by exchange");
	});

	it("isolates portal presses and cancels only the selected order, without placing before cancellation", async () => {
		render();
		pick();
		await flush();
		expect(rowPointerDown).not.toHaveBeenCalled();
		expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith({ cancels: [{ a: 0, o: 42 }] });
		expect(mocks.place).not.toHaveBeenCalled();
		expect(chip()?.textContent).toBe("GTC…");
		expect(chip()?.getAttribute("aria-busy")).toBe("true");
		expect(mocks.success).not.toHaveBeenCalled();
		expect(document.querySelector('[role="menu"]')).toBeNull();
	});

	it("flips the menu directly above its label using its measured height", () => {
		const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
			this: HTMLElement,
		) {
			return (
				this.getAttribute("role") === "menu"
					? { width: 208, height: 171 }
					: { left: 100, top: window.innerHeight - 68, bottom: window.innerHeight - 46 }
			) as DOMRect;
		});
		try {
			render();
			press(chip());
			const menu = document.querySelector<HTMLElement>('[role="menu"]');
			expect(menu?.style.top).toBe(`${window.innerHeight - 68 - 171 - 4}px`);
			expect(menu?.style.left).toBe("100px");
			expect(mocks.cancel).not.toHaveBeenCalled();
		} finally {
			bounds.mockRestore();
		}
	});

	it("keeps pending state across row remounts and rejects repeat clicks", async () => {
		render();
		pick();
		await flush();
		for (let tick = 0; tick < 5; tick++) {
			render({ ...order }, `tick-${tick}`);
			expect(chip()?.textContent).toBe("GTC…");
			press(chip());
		}
		expect(mocks.cancel).toHaveBeenCalledTimes(1);
		expect(document.querySelector('[role="menu"]')).toBeNull();
	});

	it.each([
		["Alo", "Gtc", "GTC"],
		["Gtc", "Alo", "Post Only"],
	] as const)(
		"keeps one chart placeholder through %s -> %s cancellation and readback",
		async (sourceTif, targetTif, label) => {
			const source = { ...order, tif: sourceTif };
			const replacement = { ...source, oid: 99, tif: targetTif };
			let placed!: (result: typeof resting) => void;
			let confirmed!: (result: ReturnType<typeof snapshot>) => void;
			mocks.cancel.mockResolvedValue(cancelOk);
			mocks.place.mockImplementation(
				() =>
					new Promise((resolve) => {
						placed = resolve;
					}),
			);
			mocks.orderStatus
				.mockReset()
				.mockResolvedValueOnce(snapshot("open", source))
				.mockResolvedValueOnce(snapshot("canceled", source))
				.mockImplementation(
					() =>
						new Promise((resolve) => {
							confirmed = resolve;
						}),
				);
			render(source);
			pick(label);
			await flush();
			const pending = () => useOrderMoveStore.getState().moves;
			expect(mergeChartOrderMoves([], pending())).toEqual([source]);
			expect(pending()[42]).toMatchObject({ pending: true, kind: "type" });
			// Cancellation removes the original chart row while the async job keeps running.
			act(() => root.render(null));
			await act(async () => placed(resting));
			expect(mergeChartOrderMoves([source, replacement], pending())).toEqual([
				expect.objectContaining({ oid: 99, tif: targetTif, limitPx: source.limitPx }),
			]);
			expect(pending()[42].pending).toBe(true);
			expect(useOrderMoveStore.getState().isMoving(99)).toBe(true);
			await act(async () => confirmed(snapshot("open", replacement)));
			expect(pending()[42].pending).toBe(false);
			expect(mergeChartOrderMoves([], pending())).toEqual([replacement]);
			expect(mocks.place).toHaveBeenCalledTimes(1);
		},
	);

	it("does not repost when cancellation fails, and keeps the error visible", async () => {
		mocks.cancel.mockRejectedValue(new Error("Cancel rejected"));
		render();
		pick();
		await flush();
		expect(chip()?.textContent).toBe("Post Only !");
		expect(chip()?.title).toBe("Cancel rejected");
		expect(mocks.place).not.toHaveBeenCalled();
		expect(mocks.success).not.toHaveBeenCalled();
	});

	it("reposts the exact price/size/side/reduce-only, with a fresh cloid and tracks the new oid", async () => {
		setupRepost();
		render();
		pick();
		await flush();
		expect(mocks.place).toHaveBeenCalledExactlyOnceWith({
			orders: [
				{
					a: 0,
					b: true,
					p: "84000",
					s: "0.02",
					r: false,
					t: { limit: { tif: "Gtc" } },
					c: expect.stringMatching(/^0x[0-9a-f]{32}$/),
				},
			],
			grouping: "na",
		});
		expect(mocks.cancel.mock.invocationCallOrder[0]).toBeLessThan(mocks.place.mock.invocationCallOrder[0]);
		expect(mocks.orderStatus).toHaveBeenLastCalledWith(
			{ user: "0x0000000000000000000000000000000000000001", oid: 99 },
			expect.any(AbortSignal),
		);
		expect(mocks.success).toHaveBeenCalledWith("BTC order #99 confirmed GTC by exchange");
		render({ ...order, oid: 99, tif: "Alo" }, "replacement-stale-feed");
		expect(chip()?.textContent).toBe("GTC");
		expect(chip()?.className).not.toContain("text-brand");
	});

	it("requires cancellation read-back, not just the cancel acknowledgement", async () => {
		vi.useFakeTimers();
		mocks.cancel.mockResolvedValue(cancelOk);
		render();
		pick();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(16_000);
		});
		expect(mocks.place).not.toHaveBeenCalled();
		expect(chip()?.title).toContain("Cancellation outcome unconfirmed");
		expect(mocks.addOrder).toHaveBeenCalledWith(
			expect.objectContaining({ status: "failed", error: expect.stringContaining("No replacement sent") }),
		);
	});

	it("does not report a new resting order as confirmed until its TIF is read back", async () => {
		setupRepost();
		mocks.orderStatus
			.mockReset()
			.mockResolvedValueOnce(snapshot("open"))
			.mockResolvedValueOnce(snapshot("canceled"))
			.mockImplementation(() => new Promise(() => {}));
		render();
		pick();
		await flush();
		expect(mocks.place).toHaveBeenCalledTimes(1);
		expect(mocks.success).not.toHaveBeenCalled();
		expect(chip()?.textContent).toBe("GTC…");
	});

	it("still surfaces an unchanged TIF instead of hiding it after a repost", async () => {
		vi.useFakeTimers();
		setupRepost("Alo");
		render();
		pick();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1700);
		});
		expect(mocks.success).not.toHaveBeenCalled();
		render({ ...order, oid: 99 }, "replacement-error");
		expect(chip()?.title).toContain("exchange still reports Post Only, not GTC");
		act(() => root.render(createElement(OrderTifStatus, { order: { ...order, oid: 99 } })));
		expect(container.textContent).toContain("Type change not confirmed");
	});

	it("does not retry placement or silently restore an original after a submission failure", async () => {
		setupRepost();
		mocks.place.mockRejectedValue(new Error("Placement rejected"));
		render();
		pick();
		await flush();
		expect(mocks.cancel).toHaveBeenCalledTimes(1);
		expect(mocks.place).toHaveBeenCalledTimes(1);
		expect(mocks.addOrder).toHaveBeenCalledWith(
			expect.objectContaining({ status: "failed", error: expect.stringContaining("Original order canceled") }),
		);
		expect(chip()?.title).toContain("Placement rejected");
		expect(useOrderMoveStore.getState().moves[42]).toMatchObject({
			pending: false,
			error: expect.stringContaining("Placement rejected"),
		});
		expect(mocks.success).not.toHaveBeenCalled();
	});

	it("checks per-order cancel errors even if the promise resolves", async () => {
		mocks.cancel.mockResolvedValue({ response: { data: { statuses: [{ error: "Already filled" }] } } });
		render();
		pick();
		await flush();
		expect(chip()?.title).toBe("Already filled");
		expect(mocks.place).not.toHaveBeenCalled();
	});

	it("does not touch an order that filled before cancellation", async () => {
		mocks.orderStatus.mockResolvedValue(snapshot("filled"));
		render();
		pick();
		await flush();
		expect(mocks.cancel).not.toHaveBeenCalled();
		expect(mocks.place).not.toHaveBeenCalled();
		expect(chip()?.title).toContain("no longer open");
	});

	it("does not recreate a position if the order fills during cancellation", async () => {
		setupRepost();
		mocks.orderStatus
			.mockReset()
			.mockResolvedValueOnce(snapshot("open"))
			.mockResolvedValue(snapshot("filled", { ...order, sz: "0" }));
		render();
		pick();
		await flush();
		expect(mocks.place).not.toHaveBeenCalled();
		expect(mocks.notice).toHaveBeenCalledWith("BTC order filled during cancellation. Nothing reposted.");
		expect(mergeChartOrderMoves([], useOrderMoveStore.getState().moves)).toEqual([]);
	});

	it("reposts only the final unfilled quantity after partial fills", async () => {
		setupRepost("Gtc", "0.015");
		render();
		pick();
		await flush();
		expect(mocks.place).toHaveBeenCalledWith(
			expect.objectContaining({ orders: [expect.objectContaining({ p: "84000", s: "0.015" })] }),
		);
	});

	it("does not resurrect a different price changed during the cancellation race", async () => {
		setupRepost();
		mocks.orderStatus
			.mockReset()
			.mockResolvedValueOnce(snapshot("open"))
			.mockResolvedValue(snapshot("canceled", { ...order, limitPx: "85000" }));
		render();
		pick();
		await flush();
		expect(mocks.place).not.toHaveBeenCalled();
		expect(chip()?.title).toContain("Order changed during cancellation");
	});

	it.each(["0", "0.03", "NaN"])("never reposts an invalid/increased final remaining size: %s", async (size) => {
		setupRepost("Gtc", size);
		render();
		pick();
		await flush();
		expect(mocks.place).not.toHaveBeenCalled();
		expect(chip()?.title).toContain("final remaining size");
	});

	it("never cancels a limit with attached protective TP/SL children", async () => {
		mocks.orderStatus.mockResolvedValue(
			snapshot("open", { ...order, children: [{ ...order, oid: 50, isTrigger: true }] }),
		);
		render();
		pick();
		await flush();
		expect(mocks.cancel).not.toHaveBeenCalled();
		expect(mocks.place).not.toHaveBeenCalled();
		expect(chip()?.title).toContain("attached TP/SL");
	});

	it("does not cancel a repriced order from a stale chart snapshot", async () => {
		mocks.orderStatus.mockResolvedValue(snapshot("open", { ...order, limitPx: "85000" }));
		render();
		pick();
		await flush();
		expect(mocks.cancel).not.toHaveBeenCalled();
		expect(chip()?.title).toContain("Order changed");
	});

	it("confirms an already-correct exchange type without canceling or reposting", async () => {
		mocks.orderStatus.mockResolvedValue(snapshot("open", { ...order, tif: "Gtc" }));
		render();
		pick();
		await flush();
		expect(chip()?.textContent).toBe("GTC");
		expect(mocks.cancel).not.toHaveBeenCalled();
		expect(mocks.place).not.toHaveBeenCalled();
	});

	it("does not invent GTC when TIF is missing", () => {
		expect(tifLabel(null)).toBe("Unknown");
		act(() => root.render(createElement(OrderTifStatus, { order: { ...order, tif: null } })));
		expect(container.textContent).toBe("Unknown");
	});

	it("shows actual TIF separately from a pending request in Open Orders", () => {
		act(() => {
			useTifOverrideStore.getState().setOverride(42, "Gtc");
			root.render(createElement(OrderTifStatus, { order }));
		});
		expect(container.textContent).toBe("Post OnlyChanging to GTC…");
	});

	it("does not give trigger orders a TIF control", () => {
		render({ ...order, isTrigger: true, orderType: "Take Profit Limit" });
		expect(chip()).toBeNull();
		expect(mocks.cancel).not.toHaveBeenCalled();
	});

	it("closes the portal backdrop without starting a drag", () => {
		render();
		press(chip());
		press(document.querySelector('button[aria-label="Close"]'));
		expect(rowPointerDown).not.toHaveBeenCalled();
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(mocks.cancel).not.toHaveBeenCalled();
	});
});

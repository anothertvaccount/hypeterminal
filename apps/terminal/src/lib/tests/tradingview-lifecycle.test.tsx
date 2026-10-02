// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TradingViewChart } from "@/components/trade/chart/tradingview-chart";

const mocks = vi.hoisted(() => ({ save: vi.fn(), load: vi.fn() }));
vi.mock("@/lib/chart/load-tradingview", () => ({ loadTradingViewScript: async () => {} }));
vi.mock("@/lib/chart/theme-colors", () => ({
	buildChartOverrides: () => ({}),
	getLoadingScreenColors: () => ({}),
	getToolbarBgColor: () => "black",
	generateChartCssUrl: async () => "blob:css",
}));
vi.mock("@/components/trade/chart/datafeed", () => ({ createDatafeed: () => ({}) }));
vi.mock("@/components/trade/chart/tradingview/tv-save-load", () => ({
	saveWidgetState: mocks.save,
	loadWidgetState: mocks.load,
}));
vi.mock("@/components/trade/chart/tradingview/use-tv-calibration", () => ({
	useTvCalibration: () => ({ get: () => null }),
}));
vi.mock("@/components/trade/chart/price-axis-menu", () => ({
	PriceAxisMenu: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/trade/chart/tradingview/tradingview-overlay-layer", () => ({
	TradingViewOverlayLayer: () => createElement("span", { "data-ready-overlay": true }),
}));
vi.mock("@/components/trade/chart/tradingview/tradingview-hold-click", () => ({ TradingViewHoldClick: () => null }));

const widgets: WidgetDouble[] = [];
class WidgetDouble {
	ready = () => {};
	subscribe = vi.fn();
	unsubscribe = vi.fn();
	remove = vi.fn();
	activeChart = () => ({ getPanes: () => [] });
	constructor() {
		widgets.push(this);
	}
	onChartReady(callback: () => void) {
		this.ready = callback;
	}
}
let root: Root;
let host: HTMLDivElement;
async function render(symbol = "BTC") {
	await act(async () => root.render(createElement(TradingViewChart, { symbol })));
}
beforeEach(() => {
	vi.clearAllMocks();
	widgets.length = 0;
	vi.stubGlobal("TradingView", { widget: WidgetDouble });
	vi.stubGlobal("URL", { revokeObjectURL: vi.fn() });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
describe("TradingView readiness and teardown", () => {
	it("does not queue subscription or unsubscribe work when removed before ready", async () => {
		await render();
		const widget = widgets[0];
		expect(widget.subscribe).not.toHaveBeenCalled();
		act(() => root.render(null));
		act(() => widget.ready()); // A late readiness callback from the destroyed iframe.
		expect(widget.remove).toHaveBeenCalledTimes(1);
		expect(widget.subscribe).not.toHaveBeenCalled();
		expect(widget.unsubscribe).not.toHaveBeenCalled();
	});
	it("unsubscribes the ready widget and disables overlays until its replacement is ready", async () => {
		await render();
		const first = widgets[0];
		act(() => first.ready());
		expect(host.querySelector("[data-ready-overlay]")).not.toBeNull();
		const handler = first.subscribe.mock.calls[0][1];
		await render("ETH");
		const second = widgets[1];
		expect(first.unsubscribe).toHaveBeenCalledWith("onAutoSaveNeeded", handler);
		expect(first.unsubscribe.mock.invocationCallOrder[0]).toBeLessThan(first.remove.mock.invocationCallOrder[0]);
		expect(host.querySelector("[data-ready-overlay]")).toBeNull();
		handler();
		expect(mocks.save).not.toHaveBeenCalled();
		act(() => root.render(null));
		act(() => second.ready());
		expect(second.subscribe).not.toHaveBeenCalled();
		expect(second.unsubscribe).not.toHaveBeenCalled();
	});
});

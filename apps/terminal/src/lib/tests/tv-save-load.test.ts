import { describe, expect, it } from "vitest";
import { sanitizeTvState } from "@/components/trade/chart/tradingview/tv-save-load";

type Pane = { leftAxisesState: unknown[]; rightAxisesState: unknown[] };
type State = { charts: Array<{ panes: Pane[] }> };

const axis = () => [{ state: { id: "main" } }];

describe("sanitizeTvState", () => {
	it("moves a left-side price axis back to the right side", () => {
		const state = {
			layout: "s",
			charts: [{ panes: [{ leftAxisesState: axis(), rightAxisesState: [] }] }],
		} as unknown as State;
		const { state: out, healed } = sanitizeTvState(state as unknown as object);
		expect(healed).toBe(true);
		const pane = (out as State).charts[0].panes[0];
		expect(pane.leftAxisesState).toEqual([]);
		expect(pane.rightAxisesState).toHaveLength(1);
	});

	it("keeps existing right-side axes when healing extra left entries", () => {
		const state = {
			charts: [{ panes: [{ leftAxisesState: [{ state: { id: "extra" } }], rightAxisesState: axis() }] }],
		} as unknown as State;
		const { healed } = sanitizeTvState(state as unknown as object);
		expect(healed).toBe(true);
		const pane = state.charts[0].panes[0];
		expect(pane.rightAxisesState).toHaveLength(2);
		expect(pane.leftAxisesState).toEqual([]);
	});

	it("leaves a normal right-side state untouched", () => {
		const state = { charts: [{ panes: [{ leftAxisesState: [], rightAxisesState: axis() }] }] } as unknown as State;
		const { healed } = sanitizeTvState(state as unknown as object);
		expect(healed).toBe(false);
		expect(state.charts[0].panes[0].rightAxisesState).toHaveLength(1);
	});

	it("overwrites the saved symbol with the current market (app market must win)", () => {
		const state = {
			charts: [
				{
					panes: [
						{
							leftAxisesState: [],
							rightAxisesState: axis(),
							sources: [{ type: "MainSeries", state: { symbol: "BTC", shortName: "BTC/USDC", "plot.color": "#fff" } }],
						},
					],
				},
			],
		} as unknown as State;
		const { state: out, healed } = sanitizeTvState(state as unknown as object, "ETH");
		expect(healed).toBe(true);
		const series = (
			out as State & { charts: Array<{ panes: Array<{ sources: Array<{ state: Record<string, unknown> }> }> }> }
		).charts[0].panes[0].sources[0];
		expect(series.state.symbol).toBe("ETH");
		expect(series.state.shortName).toBe("ETH/USDC"); // quote side preserved
		expect(series.state["plot.color"]).toBe("#fff"); // other series props survive
	});

	it("keeps the saved symbol when no current symbol is given (save path)", () => {
		const state = {
			charts: [{ panes: [{ sources: [{ type: "MainSeries", state: { symbol: "BTC", shortName: "BTC/USDC" } }] }] }],
		} as unknown as State;
		const { healed } = sanitizeTvState(state as unknown as object);
		expect(healed).toBe(false);
		const series = (
			state as unknown as { charts: Array<{ panes: Array<{ sources: Array<{ state: Record<string, unknown> }> }> }> }
		).charts[0].panes[0].sources[0];
		expect(series.state.symbol).toBe("BTC");
	});

	it("leaves study sources (no MainSeries state) alone", () => {
		const state = {
			charts: [{ panes: [{ sources: [{ type: "Study", state: { symbol: "BTC" } }] }] }],
		} as unknown as State;
		const { healed } = sanitizeTvState(state as unknown as object, "ETH");
		expect(healed).toBe(false);
	});

	it("passes through states without chart panes (multiple layouts, old shapes)", () => {
		expect(sanitizeTvState({ layout: "2x1" }).healed).toBe(false);
		expect(sanitizeTvState({ charts: [{ nope: 1 }] }).healed).toBe(false);
		expect(sanitizeTvState({}).healed).toBe(false);
	});
});

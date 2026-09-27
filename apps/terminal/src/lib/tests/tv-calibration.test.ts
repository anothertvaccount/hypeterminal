import { describe, expect, it } from "vitest";
import {
	buildTvMeasurement,
	type TvMeasurementInput,
	tvPriceToViewportY,
	tvViewportYToPrice,
} from "@/components/trade/chart/tradingview/tv-calibration";

/**
 * TradingView price↔pixel fit: a linear map from the visible price range onto the
 * iframe's plot rect (offset into viewport space). Higher prices map to the TOP,
 * the axis is excluded from the plot, and price↔y round-trips exactly — every
 * overlay row, drag, axis-menu price and chart click depends on this.
 */
describe("tv calibration", () => {
	const input: TvMeasurementInput = {
		iframeRect: { left: 0, top: 100, width: 800, height: 600 },
		guiRect: { left: 40, top: 40, width: 700, height: 500 }, // plot excl. axis (60px) + chrome
		axisRect: { left: 740, top: 40, width: 60, height: 500 },
		range: { from: 90_000, to: 80_000 },
	};

	it("maps the visible range onto the plot in viewport space, high price on top", () => {
		const m = buildTvMeasurement(input);
		expect(m).not.toBeNull();
		if (!m) return;
		// iframe offset (top=100) + gui offset (top=40) → plot starts at 140.
		expect(m.plot.top).toBe(140);
		expect(m.plot.bottom).toBe(640);
		expect(m.plot.left).toBe(40);
		expect(m.plot.right).toBe(740); // stops at the axis
		expect(m.axis.left).toBe(740);
		expect(m.priceTop).toBe(90_000);
		expect(m.priceBottom).toBe(80_000);
		expect(tvPriceToViewportY(m, 90_000)).toBe(m.plot.top);
		expect(tvPriceToViewportY(m, 80_000)).toBe(m.plot.bottom);
		expect(tvPriceToViewportY(m, 85_000)).toBeCloseTo((m.plot.top + m.plot.bottom) / 2, 6);
	});

	it("round-trips price → y → price (drags depend on it)", () => {
		const m = buildTvMeasurement(input);
		if (!m) throw new Error("no measurement");
		for (const price of [80_000, 81_234.5, 85_000, 89_999]) {
			const y = tvPriceToViewportY(m, price);
			expect(tvViewportYToPrice(m, y)).toBeCloseTo(price, 6);
		}
	});

	it("normalizes an inverted range and rejects degenerate input", () => {
		const flipped = buildTvMeasurement({ ...input, range: { from: 80_000, to: 90_000 } });
		expect(flipped?.priceTop).toBe(90_000);
		const flat = buildTvMeasurement({ ...input, range: { from: 85_000, to: 85_000 } });
		expect(flat).toBeNull();
		const tiny = buildTvMeasurement({ ...input, guiRect: { left: 0, top: 0, width: 10, height: 10 } });
		expect(tiny).toBeNull();
	});

	it("falls back to a right-edge axis band when the axis element is missing", () => {
		const m = buildTvMeasurement({ ...input, axisRect: null });
		if (!m) throw new Error("no measurement");
		expect(m.axis.width).toBe(60);
		expect(m.plot.right).toBe(m.axis.left);
	});
});

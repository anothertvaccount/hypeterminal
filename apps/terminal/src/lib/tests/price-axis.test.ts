import { describe, expect, it } from "vitest";
import {
	AXIS_MENU_ITEMS,
	CROSS_HOVER_EXTENSION,
	clampAxisY,
	getCrossLeft,
	getMenuRightOffset,
	isOnPriceAxis,
	resolveAxisPrice,
	TPSL_PERCENTAGES,
} from "@/lib/chart/price-axis";

const AXIS = { left: 750, top: 0, right: 800, bottom: 500 };
const WRAPPER = { left: 0, top: 0, width: 800, height: 500 };

describe("isOnPriceAxis", () => {
	it("detects pointers inside the axis bounds", () => {
		expect(isOnPriceAxis(775, 250, AXIS)).toBe(true);
		expect(isOnPriceAxis(750, 0, AXIS)).toBe(true);
		expect(isOnPriceAxis(800, 500, AXIS)).toBe(true);
	});

	it("rejects pointers outside the axis", () => {
		expect(isOnPriceAxis(749, 250, AXIS)).toBe(false); // left of the axis (over the chart)
		expect(isOnPriceAxis(801, 250, AXIS)).toBe(false); // beyond the right edge
		expect(isOnPriceAxis(775, 501, AXIS)).toBe(false); // below the candle pane
		expect(isOnPriceAxis(775, -1, AXIS)).toBe(false);
	});

	it("extends the hover zone left of the labels to cover the cross", () => {
		// Default: strictly on-axis. With the extension: reaches axis.left - 20.
		expect(isOnPriceAxis(745, 250, AXIS)).toBe(false);
		expect(isOnPriceAxis(745, 250, AXIS, CROSS_HOVER_EXTENSION)).toBe(true);
		expect(isOnPriceAxis(730, 250, AXIS, CROSS_HOVER_EXTENSION)).toBe(true); // exactly at the edge
		expect(isOnPriceAxis(729, 250, AXIS, CROSS_HOVER_EXTENSION)).toBe(false);
	});
});

describe("getCrossLeft", () => {
	it("sits just inside the pane, next to the axis border (never on the labels)", () => {
		// axis.left(750) - wrapper.left(0) - half(8) - gap(4) = 738 — left of the axis.
		expect(getCrossLeft(AXIS, WRAPPER)).toBe(738);
		expect(getCrossLeft(AXIS, WRAPPER)).toBeLessThan(AXIS.left - WRAPPER.left);
	});

	it("is relative to the wrapper, not the viewport", () => {
		expect(getCrossLeft({ ...AXIS, left: 150, right: 200 }, { ...WRAPPER, left: 100 })).toBe(38);
	});
});

describe("TPSL_PERCENTAGES", () => {
	it("offers the positive size presets (25/50/75/100)", () => {
		expect([...TPSL_PERCENTAGES]).toEqual([25, 50, 75, 100]);
	});
});

describe("getMenuRightOffset", () => {
	it("places the menu just left of the axis", () => {
		// wrapper.width - axisInset + gap = 800 - 750 + 8
		expect(getMenuRightOffset(AXIS, WRAPPER)).toBe(58);
		expect(getMenuRightOffset(AXIS, WRAPPER, 12)).toBe(62);
	});

	it("accounts for a wrapper that does not start at the viewport edge", () => {
		expect(getMenuRightOffset({ ...AXIS, left: 850, right: 900 }, { ...WRAPPER, left: 100, width: 800 })).toBe(58);
	});
});

describe("clampAxisY", () => {
	it("keeps the element inside the wrapper vertically", () => {
		expect(clampAxisY(250, 500, 10)).toBe(250);
		expect(clampAxisY(2, 500, 10)).toBe(10);
		expect(clampAxisY(499, 500, 10)).toBe(490);
	});

	it("degrades safely for tiny wrappers", () => {
		expect(clampAxisY(250, 10, 64)).toBe(64);
		expect(clampAxisY(-5, 0, 10)).toBe(10);
		expect(Number.isNaN(clampAxisY(Number.NaN, 500, 10))).toBe(false);
	});
});

describe("resolveAxisPrice", () => {
	it("formats valid prices to Hyperliquid tick precision", () => {
		expect(resolveAxisPrice(1234.5678)).toBe("1234.6"); // 5 significant figures
		expect(resolveAxisPrice(104_235.678)).toBe("104236");
		expect(resolveAxisPrice(0.000012345)).toBe("0.00001235");
	});

	it("rejects unusable prices", () => {
		expect(resolveAxisPrice(0)).toBeNull();
		expect(resolveAxisPrice(-5)).toBeNull();
		expect(resolveAxisPrice(Number.NaN)).toBeNull();
		expect(resolveAxisPrice(Number.POSITIVE_INFINITY)).toBeNull();
		expect(resolveAxisPrice(1e-12)).toBeNull(); // rounds down to "0"
	});
});

describe("AXIS_MENU_ITEMS", () => {
	it("offers limit buy and limit sell", () => {
		expect(AXIS_MENU_ITEMS).toHaveLength(2);
		expect(AXIS_MENU_ITEMS[0]).toMatchObject({ side: "buy", label: "Limit Buy" });
		expect(AXIS_MENU_ITEMS[1]).toMatchObject({ side: "sell", label: "Limit Sell" });
	});
});

import { describe, expect, it } from "vitest";
import {
	matchScalePreset,
	SCALE_DIST_AMOUNT_PRESETS,
	SCALE_DIST_PRICE_PRESETS,
	sampleScaleCurve,
} from "@/domain/trade/order/scale-distribution";
import { getScaleLevelPrices, getScaleLevelSizes } from "@/domain/trade/orders";

describe("sampleScaleCurve", () => {
	it("pins the endpoints and interpolates linearly between nodes", () => {
		const nodes = [0, 0.25, 0.5, 0.75, 1];
		expect(sampleScaleCurve(nodes, 0)).toBe(0);
		expect(sampleScaleCurve(nodes, 1)).toBe(1);
		expect(sampleScaleCurve(nodes, 0.125)).toBeCloseTo(0.125, 9);
		// A node position samples exactly its node value.
		expect(sampleScaleCurve(nodes, 0.5)).toBeCloseTo(0.5, 9);
	});
	it("clamps outside t to the endpoints", () => {
		const nodes = [0, 0.5, 1];
		expect(sampleScaleCurve(nodes, -1)).toBe(0);
		expect(sampleScaleCurve(nodes, 2)).toBe(1);
	});
});

describe("scale distributions", () => {
	it("a price curve reshapes spacing but keeps exact endpoints", () => {
		const prices = getScaleLevelPrices("83000", "85000", 4, SCALE_DIST_PRICE_PRESETS.end);
		// End-heavy curve: rungs bunch near the END (83667 linear becomes 84000/84667).
		expect(prices).toEqual(["83000", "84000", "84667", "85000"]);
		const startHeavy = getScaleLevelPrices("83000", "85000", 4, SCALE_DIST_PRICE_PRESETS.start);
		expect(startHeavy[0]).toBe("83000");
		expect(startHeavy[startHeavy.length - 1]).toBe("85000");
		expect(startHeavy).not.toEqual(prices);
	});

	it("null / no curve stays byte-identical to the linear ladder", () => {
		expect(getScaleLevelPrices("83000", "85000", 4, null)).toEqual(getScaleLevelPrices("83000", "85000", 4));
		expect(getScaleLevelPrices("83000", "85000", 4, [])).toEqual(getScaleLevelPrices("83000", "85000", 4));
	});

	it("an amount curve splits sizes unevenly but never exceeds the total", () => {
		const sizes = getScaleLevelSizes(0.001, 4, 5, SCALE_DIST_AMOUNT_PRESETS.end);
		expect(new Set(sizes).size).toBeGreaterThan(1); // not uniform
		expect(sizes.reduce((sum, s) => sum + Number(s), 0)).toBeLessThanOrEqual(0.001);
		expect(sizes.every((s) => Number(s) > 0)).toBe(true);
		// uniform path unchanged:
		expect(getScaleLevelSizes(0.001, 4, 5)).toEqual(["0.00025", "0.00025", "0.00025", "0.00025"]);
	});

	it("falls back to the uniform split when a curve would zero a rung", () => {
		// Extreme nodes (all weight at the start) zero out later rungs at this size
		// precision — a zero-size order must never be emitted.
		const sizes = getScaleLevelSizes(0.001, 4, 5, [1, 0, 0, 0, 0]);
		expect(sizes).toEqual(["0.00025", "0.00025", "0.00025", "0.00025"]);
	});
});

describe("matchScalePreset", () => {
	it("maps null → flat, exact arrays → their key, anything else → custom", () => {
		const presets = SCALE_DIST_PRICE_PRESETS;
		expect(matchScalePreset(null, presets)).toBe("flat");
		expect(matchScalePreset([...presets.flat], presets)).toBe("flat");
		expect(matchScalePreset([...presets.start], presets)).toBe("start");
		expect(matchScalePreset([...presets.end], presets)).toBe("end");
		expect(matchScalePreset([0, 0.2, 0.5, 0.8, 1], presets)).toBe("custom");
	});
});

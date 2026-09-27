// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DEFAULT_SIZE_BUTTON_AMOUNTS } from "@/config/trade";
import { increaseSizeByUsd } from "@/domain/trade/order/size-steps";
import { formatSizeForOrder } from "@/domain/trade/orders";

describe("increaseSizeByUsd (quick size chips)", () => {
	it("uses the documented defaults", () => {
		expect([...DEFAULT_SIZE_BUTTON_AMOUNTS]).toEqual([5, 50, 100, 250, 500]);
	});

	it("quote mode adds exactly, rounding cents", () => {
		expect(increaseSizeByUsd({ currentUsd: 10, amountUsd: 50, markPx: 85_000, sizeMode: "quote", szDecimals: 4 })).toBe(
			"60",
		);
		expect(
			increaseSizeByUsd({ currentUsd: 10.999, amountUsd: 5, markPx: 85_000, sizeMode: "quote", szDecimals: 4 }),
		).toBe("16");
	});

	it("treats an empty or invalid current size as zero", () => {
		expect(
			increaseSizeByUsd({ currentUsd: Number.NaN, amountUsd: 50, markPx: 50, sizeMode: "quote", szDecimals: 4 }),
		).toBe("50");
		expect(increaseSizeByUsd({ currentUsd: -5, amountUsd: 50, markPx: 50, sizeMode: "quote", szDecimals: 4 })).toBe(
			"50",
		);
	});

	it("base mode converts the USD target through the mark", () => {
		const next = increaseSizeByUsd({ currentUsd: 100, amountUsd: 50, markPx: 50, sizeMode: "base", szDecimals: 4 });
		expect(next).toBe(formatSizeForOrder(3, 4)); // (100 + 50) / 50
	});

	it("rounds to the nearest size step instead of flooring the chip", () => {
		// BTC: 0.00001 step at ~$84k. Flooring a $5 chip gave 0.00005 = $4.20 (16%
		// short of the button); the nearest step is 0.00006 = $5.04.
		expect(increaseSizeByUsd({ currentUsd: 0, amountUsd: 5, markPx: 84_000, sizeMode: "base", szDecimals: 5 })).toBe(
			"0.00006",
		);
		expect(increaseSizeByUsd({ currentUsd: 0, amountUsd: 50, markPx: 84_000, sizeMode: "base", szDecimals: 5 })).toBe(
			"0.0006",
		);
	});

	it("keeps the zeros of whole sizes on szDecimals 0 markets", () => {
		// 134 of 234 perps use szDecimals 0. An integer size ending in 0 must survive
		// the formatter: it used to come out 10×/100× too small.
		expect(increaseSizeByUsd({ currentUsd: 0, amountUsd: 100, markPx: 1, sizeMode: "base", szDecimals: 0 })).toBe(
			"100",
		);
		expect(increaseSizeByUsd({ currentUsd: 0, amountUsd: 500, markPx: 0.2, sizeMode: "base", szDecimals: 0 })).toBe(
			"2500",
		);
		expect(increaseSizeByUsd({ currentUsd: 0, amountUsd: 50, markPx: 1, sizeMode: "base", szDecimals: 0 })).toBe("50");
	});

	it("never rounds past the cap", () => {
		// 100 / 1.5 = 66.7 → 67 rounded, but only 66 fits under the cap.
		expect(
			increaseSizeByUsd({ currentUsd: 0, amountUsd: 100, markPx: 1.5, sizeMode: "base", szDecimals: 0, maxSize: 66 }),
		).toBe("66");
		expect(
			increaseSizeByUsd({ currentUsd: 0, amountUsd: 100, markPx: 1, sizeMode: "base", szDecimals: 0, maxSize: 50 }),
		).toBe("50");
	});

	it("returns null when the amount rounds away at the market precision", () => {
		expect(
			increaseSizeByUsd({ currentUsd: 0, amountUsd: 5, markPx: 1_000_000, sizeMode: "base", szDecimals: 0 }),
		).toBeNull();
	});

	it("refuses invalid inputs instead of corrupting the field", () => {
		expect(
			increaseSizeByUsd({ currentUsd: 10, amountUsd: -5, markPx: 50, sizeMode: "quote", szDecimals: 4 }),
		).toBeNull();
		expect(
			increaseSizeByUsd({ currentUsd: 10, amountUsd: Number.NaN, markPx: 50, sizeMode: "quote", szDecimals: 4 }),
		).toBeNull();
		expect(increaseSizeByUsd({ currentUsd: 10, amountUsd: 50, markPx: 0, sizeMode: "base", szDecimals: 4 })).toBeNull();
		expect(
			increaseSizeByUsd({ currentUsd: 10, amountUsd: 50, markPx: Number.NaN, sizeMode: "base", szDecimals: 4 }),
		).toBeNull();
	});
});

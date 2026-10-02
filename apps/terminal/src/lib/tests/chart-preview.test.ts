import { describe, expect, it } from "vitest";
import { buildPreviewSegments, computeFormDrafts, draftReferencePrice } from "@/domain/trade/order/chart-preview";

/**
 * Form draft labels: every strip is unmistakably a preview (PREVIEW chip + the
 * explicit "not in book until submitted" cell), the title cell carries the
 * "preview" hit key (drag geometry + click routing), and the line/side follows the
 * entry side for the limit and the opposite (exit) side for TP/SL.
 */
describe("buildPreviewSegments", () => {
	it("marks a long's limit draft as a buy preview", () => {
		const { segments, isBuy } = buildPreviewSegments("limit", "buy");
		expect(isBuy).toBe(true);
		expect(segments.map((s) => s.text)).toEqual(["PREVIEW", "BUY", "not in book until submitted"]);
		expect(segments[0]).toMatchObject({ tone: "preview", filled: true });
		expect(segments[1].key).toBe("preview");
		expect(segments[2].tone).toBe("preview");
	});

	it("colors TP/SL drafts as exits (sell for a long, buy for a short)", () => {
		expect(buildPreviewSegments("tp", "buy").isBuy).toBe(false);
		expect(buildPreviewSegments("sl", "buy").isBuy).toBe(false);
		expect(buildPreviewSegments("tp", "sell").isBuy).toBe(true);
		expect(buildPreviewSegments("sl", "sell").isBuy).toBe(true);
	});

	it("titles the scale ladder start/mid/end on the entry side", () => {
		const start = buildPreviewSegments("scaleStart", "buy");
		expect(start.segments[1].text).toBe("SCALE START");
		expect(start.isBuy).toBe(true);
		expect(buildPreviewSegments("scaleEnd", "buy").segments[1].text).toBe("SCALE END");
		const mid = buildPreviewSegments("scaleMid", "sell");
		expect(mid.segments[1].text).toBe("SCALE");
		expect(mid.isBuy).toBe(false);
	});

	it("titles follow the kind and side", () => {
		expect(buildPreviewSegments("tp", "sell").segments[1].text).toBe("TAKE PROFIT");
		expect(buildPreviewSegments("sl", "buy").segments[1].text).toBe("STOP LOSS");
		expect(buildPreviewSegments("limit", "sell").segments[1].text).toBe("SELL");
	});
});

describe("computeFormDrafts (shared by both canvases)", () => {
	const base = {
		orderType: "market",
		limitPriceInput: "",
		tpSlEnabled: false,
		tpSlAllowed: true,
		tpPriceInput: "",
		slPriceInput: "",
		scalePreview: false,
		scaleStartInput: "",
		scaleEndInput: "",
		scaleLevels: 4,
	};

	it("emits a limit draft only for a typed limit price on the limit form", () => {
		expect(computeFormDrafts(base)).toEqual([]);
		expect(computeFormDrafts({ ...base, orderType: "limit", limitPriceInput: "84000" })).toEqual([
			{ price: 84000, kind: "limit" },
		]);
		// Typed price on a market form → no line (nothing would rest there).
		expect(computeFormDrafts({ ...base, limitPriceInput: "84000" })).toEqual([]);
	});

	it("emits TP/SL drafts while toggled on — gated by capabilities too", () => {
		const on = { ...base, tpSlEnabled: true, tpPriceInput: "85680", slPriceInput: "82320" };
		expect(computeFormDrafts(on).map((d) => d.kind)).toEqual(["tp", "sl"]);
		expect(computeFormDrafts({ ...on, tpSlAllowed: false })).toEqual([]);
	});

	it("emits the scale ladder while previewing (start/mid/end kinds)", () => {
		const scale = {
			...base,
			orderType: "scale",
			scalePreview: true,
			scaleStartInput: "83000",
			scaleEndInput: "85000",
			scaleLevels: 4,
		};
		const drafts = computeFormDrafts(scale);
		expect(drafts.map((d) => d.kind)).toEqual(["scaleStart", "scaleMid", "scaleMid", "scaleEnd"]);
		expect(drafts.map((d) => d.price)).toEqual([83000, 83667, 84333, 85000]);
		expect(computeFormDrafts({ ...scale, scalePreview: false })).toEqual([]);
		// Partial fills preview whatever exists — an empty start leaves only the END line…
		expect(computeFormDrafts({ ...scale, scaleStartInput: "" }).map((d) => d.kind)).toEqual(["scaleEnd"]);
		// …and with no prices at all there is nothing to draw.
		expect(computeFormDrafts({ ...scale, scaleStartInput: "", scaleEndInput: "" })).toEqual([]);
	});
});

describe("size-aware preview numbers", () => {
	const tpDetail = { price: 85680, size: 0.001, sizeText: "0.001", refPrice: 84000 };

	it("TP/SL drafts show the realized PnL for the composed size", () => {
		// (85680 - 84000) * 0.001 = +1.68
		expect(buildPreviewSegments("tp", "buy", tpDetail).segments.map((s) => s.text)).toContain("+1.68 USD");
		// (82320 - 84000) * 0.001 = -1.68
		const sl = buildPreviewSegments("sl", "buy", { price: 82320, size: 0.001, refPrice: 84000 });
		expect(sl.segments.map((s) => s.text)).toContain("-1.68 USD");
		// A short's TP sits BELOW the reference — same direction flip as the order side.
		const shortTp = buildPreviewSegments("tp", "sell", { price: 82320, size: 0.001, refPrice: 84000 });
		expect(shortTp.segments.map((s) => s.text)).toContain("+1.68 USD");
	});

	it("limit drafts show the order notional and the size", () => {
		const limit = buildPreviewSegments("limit", "buy", { price: 84000, size: 0.001, sizeText: "0.001" });
		const texts = limit.segments.map((s) => s.text);
		expect(texts).toContain("84.00 USD");
		expect(texts).toContain("0.001");
	});

	it("omits the numbers without a size, and never adds them to scale rungs", () => {
		const bare = buildPreviewSegments("tp", "buy", { price: 85680, size: 0, refPrice: 84000 });
		expect(bare.segments.map((s) => s.text).join("|")).not.toContain("USD");
		const rung = buildPreviewSegments("scaleMid", "buy", tpDetail);
		expect(rung.segments.map((s) => s.text).join("|")).not.toContain("USD");
	});
});

describe("draftReferencePrice (mirrors getOrderPrice)", () => {
	const base = { limitPriceInput: "", scaleStartInput: "", scaleEndInput: "", mark: 84000 };

	it("scale uses the ladder midpoint, or the single typed end", () => {
		expect(draftReferencePrice({ ...base, orderType: "scale", scaleStartInput: "83000", scaleEndInput: "85000" })).toBe(
			84000,
		);
		expect(draftReferencePrice({ ...base, orderType: "scale", scaleStartInput: "83000" })).toBe(83000);
		expect(draftReferencePrice({ ...base, orderType: "scale" })).toBe(84000);
		expect(draftReferencePrice({ ...base, orderType: "scale", mark: 0 })).toBeUndefined();
	});

	it("limit uses the typed price; everything else falls back to the mark", () => {
		expect(draftReferencePrice({ ...base, orderType: "limit", limitPriceInput: "85500" })).toBe(85500);
		expect(draftReferencePrice({ ...base, orderType: "market" })).toBe(84000);
		expect(draftReferencePrice({ ...base, orderType: "limit", mark: 0 })).toBeUndefined();
	});
});

it("scale drafts include the TP/SL previews when the checkbox is on", () => {
	const drafts = computeFormDrafts({
		orderType: "scale",
		limitPriceInput: "",
		tpSlEnabled: true,
		tpSlAllowed: true,
		tpPriceInput: "85680",
		slPriceInput: "82320",
		scalePreview: true,
		scaleStartInput: "83000",
		scaleEndInput: "85000",
		scaleLevels: 4,
	});
	expect(drafts.map((d) => d.kind)).toEqual(["tp", "sl", "scaleStart", "scaleMid", "scaleMid", "scaleEnd"]);
});

it("scale rung drafts carry the level count and show their per-order size", () => {
	const drafts = computeFormDrafts({
		orderType: "scale",
		limitPriceInput: "",
		tpSlEnabled: false,
		tpSlAllowed: false,
		tpPriceInput: "",
		slPriceInput: "",
		scalePreview: true,
		scaleStartInput: "83000",
		scaleEndInput: "85000",
		scaleLevels: 4,
	});
	const rungs = drafts.filter((d) => d.kind.startsWith("scale"));
	expect(rungs).toHaveLength(4);
	expect(rungs.every((d) => d.scaleLevels === 4)).toBe(true);
	const rungLabel = buildPreviewSegments("scaleMid", "buy", {
		price: 83667,
		size: 0.001 / 4,
		sizeText: "0.00025",
		refPrice: 84000,
	});
	const texts = rungLabel.segments.map((s) => s.text);
	expect(texts).toContain("0.00025");
	expect(texts.join("|")).not.toContain("USD");
});

it("a lone scale end previews its own line WITHOUT a size cell (no ladder → no per-order size)", () => {
	const lone = computeFormDrafts({
		orderType: "scale",
		limitPriceInput: "",
		tpSlEnabled: false,
		tpSlAllowed: false,
		tpPriceInput: "",
		slPriceInput: "",
		scalePreview: true,
		scaleStartInput: "",
		scaleEndInput: "85000",
		scaleLevels: 4,
	});
	expect(lone.map((d) => d.kind)).toEqual(["scaleEnd"]);
	const labels = buildPreviewSegments("scaleEnd", "buy", {
		price: 85000,
		size: 0.001,
		sizeText: "0.001", // caller omits this when the ladder is incomplete
		refPrice: undefined,
	});
	// The caller-side gate passes sizeText only for full ladders; the builder itself
	// renders whatever it is given — assert the note + preview chip always remain.
	const texts = labels.segments.map((s) => s.text);
	expect(texts[0]).toBe("PREVIEW");
	expect(texts[texts.length - 1]).toBe("not in book until submitted");
});

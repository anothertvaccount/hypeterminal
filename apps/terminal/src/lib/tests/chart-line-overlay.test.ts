// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { registerOverlay } = vi.hoisted(() => ({
	registerOverlay: vi.fn(),
}));

vi.mock("klinecharts", () => ({ registerOverlay }));
vi.mock("@/lib/chart/theme-colors", () => ({
	colorToHex: (color: string) => color,
	colorToRgba: (color: string, alpha: number) => `${color}:${alpha}`,
	getChartColors: () => ({
		background: "#000000",
		foreground: "#ffffff",
		textSecondary: "#888888",
		textTertiary: "#777777",
		border: "#333333",
		green: "#00ff00",
		red: "#ff0000",
		accent: "#0000ff",
		surface: "#111111",
	}),
}));

describe("line overlays", () => {
	beforeEach(() => {
		vi.resetModules();
		registerOverlay.mockClear();
	});

	it("keeps a long phone order's cancel cell clear of the axis price-picker", async () => {
		const { registerOrderLineOverlay } = await import("@/lib/chart/order-line-overlay");
		const { CROSS_HALF, getCrossLeft } = await import("@/lib/chart/price-axis");
		registerOrderLineOverlay();
		const overlayConfig = registerOverlay.mock.calls[0]?.[0];
		const extendData = {
			getSegments: () => ({
				isBuy: true,
				segments: [
					{ text: "Post Only", tone: "buy", key: "tif" },
					{ text: "Limit [+12345.67 USD / +12345.67 USD] Reduce Only", tone: "buy" },
					{ text: "12345.67 USD", tone: "buy" },
					{ text: "✕", tone: "buy", key: "cancel" },
				],
			}),
			boxes: [] as Array<{ key: string; x1: number }>,
		};
		const figures = overlayConfig.createPointFigures({
			overlay: { extendData, points: [{ value: 84000 }] },
			coordinates: [{ x: 0, y: 42 }],
			bounding: { width: 300 },
		});
		const crossLeft =
			getCrossLeft({ left: 300, right: 360, top: 0, bottom: 500 }, { left: 0, top: 0, width: 360, height: 500 }) -
			CROSS_HALF;
		expect(extendData.boxes.find((box) => box.key === "cancel")?.x1).toBeLessThan(crossLeft);
		const texts = figures
			.filter((figure: { type: string }) => figure.type === "text")
			.map((figure: { attrs: { text: string } }) => figure.attrs.text);
		expect(texts).toContain("Post Only");
		expect(texts).toContain("✕");
		expect(texts.some((text: string) => text.endsWith("…"))).toBe(true);
	});

	it("registers the liquidation overlay once, labels the line and prices the axis", async () => {
		const { LIQUIDATION_LINE_NAME, registerLiquidationLineOverlay } = await import(
			"@/lib/chart/liquidation-line-overlay"
		);

		registerLiquidationLineOverlay();
		registerLiquidationLineOverlay();

		expect(registerOverlay).toHaveBeenCalledOnce();
		const overlayConfig = registerOverlay.mock.calls[0]?.[0];
		expect(overlayConfig).toMatchObject({
			name: LIQUIDATION_LINE_NAME,
			lock: true,
			totalStep: 1,
		});

		const figures = overlayConfig?.createPointFigures?.({
			overlay: { extendData: undefined, points: [{ value: 1234.567 }] },
			coordinates: [{ x: 0, y: 42 }],
			bounding: { width: 320 },
			precision: { price: 2 },
		});

		type StripFigure = {
			type: string;
			attrs: { text?: string; x?: number; width?: number };
			styles?: { style?: string; borderSize?: number };
		};
		const list = (figures ?? []) as StripFigure[];

		// The label sits inside a bordered strip in the pane; the price lives on the axis badge.
		const liqText = list.find((figure) => figure.type === "text" && figure.attrs.text === "Liq.");
		expect(liqText).toBeDefined();
		const strip = list.find((figure) => figure.type === "rect");
		expect(strip).toBeDefined();
		// Photo style: one continuous bordered box (stroke_fill draws the visible border).
		expect(strip?.styles).toMatchObject({ style: "stroke_fill", borderSize: 1 });
		// Positioning: inset from the left edge, never crossing the pane's center.
		expect(strip?.attrs.x ?? 0).toBeGreaterThanOrEqual(20);
		expect((strip?.attrs.x ?? 0) + (strip?.attrs.width ?? 0)).toBeLessThanOrEqual(320 / 2);

		const axisFigures = overlayConfig?.createYAxisFigures?.({
			overlay: { extendData: undefined, points: [{ value: 1234.567 }] },
			coordinates: [{ x: 0, y: 42 }],
			bounding: { width: 72 },
			precision: { price: 2 },
		});
		expect(axisFigures?.[0]).toMatchObject({
			type: "text",
			attrs: { text: "1234.57" },
		});
	});

	it("registers position overlays with long and short labels", async () => {
		const { registerPositionLineOverlay } = await import("@/lib/chart/position-line-overlay");
		const { buildPositionSegments } = await import("@/domain/trade/order/chart-labels");

		registerPositionLineOverlay();

		const overlayConfig = registerOverlay.mock.calls[0]?.[0];
		expect(overlayConfig).toMatchObject({ name: "positionLine", lock: false });

		const draw = (isLong: boolean) =>
			overlayConfig?.createPointFigures?.({
				overlay: {
					extendData: {
						getSegments: () => buildPositionSegments({ szi: isLong ? 1 : -1, entryPx: 100 }, undefined),
					},
					points: [{ value: 100 }],
				},
				coordinates: [{ x: 0, y: 20 }],
				bounding: { width: 320 },
				precision: { price: 0 },
			});

		const longTexts = (draw(true) ?? []).map((figure: { attrs?: { text?: string } }) => figure.attrs?.text);
		const shortTexts = (draw(false) ?? []).map((figure: { attrs?: { text?: string } }) => figure.attrs?.text);
		expect(longTexts).toContain("Long");
		expect(longTexts).toContain("TP");
		expect(longTexts).toContain("SL");
		expect(shortTexts).toContain("Short");
	});

	it("pins the entry row during a TP/SL drag and draws the floating ghost chip", async () => {
		const { registerPositionLineOverlay } = await import("@/lib/chart/position-line-overlay");
		registerPositionLineOverlay();

		const overlayConfig = registerOverlay.mock.calls[0]?.[0];
		const yAxis = { convertToPixel: () => 40, convertFromPixel: () => 0 };
		const extendData = {
			getSegments: () => ({ segments: [{ text: "Long", tone: "buy" as const, filled: true }], isBuy: true }),
			getResolution: () => ({
				segments: [{ text: "Long", tone: "buy" as const, filled: true }],
				isBuy: true,
				// Pinned entry pixel — the live point (y=77) must be ignored for the row.
				lineY: 40,
				ghost: {
					y: 12,
					anchor: "tp" as const,
					segments: [
						{ text: "+6.00 USD", tone: "tp" as const },
						{ text: "TP", tone: "tp" as const, filled: true },
						{ text: "+6.00%", tone: "tp" as const },
					],
				},
			}),
		};
		const figures = overlayConfig.createPointFigures({
			overlay: { extendData, points: [{ value: 106 }] },
			coordinates: [{ x: 0, y: 77 }], // the MOVED point pixel mid-drag
			bounding: { width: 320 },
			yAxis,
			precision: { price: 2 },
		});

		interface Fig {
			type: string;
			attrs: { y?: number; text?: string; coordinates?: Array<{ x: number; y: number }> };
			styles?: { color?: string };
		}
		const list = figures as unknown as Fig[];
		const lines = list.filter((f) => f.type === "line");
		const texts = list.filter((f) => f.type === "text");

		// The pinned row (line + chips) sits at lineY=40, never at the moved point y=77.
		expect(lines.every((f) => f.attrs.coordinates?.every((c) => c.y !== 77))).toBe(true);
		expect(lines.some((f) => f.attrs.coordinates?.every((c) => c.y === 40))).toBe(true);
		// Ghost row at y=12 with its horizontal + the vertical connector from the chip.
		expect(lines.some((f) => f.attrs.coordinates?.every((c) => c.y === 12))).toBe(true);
		expect(lines.some((f) => f.attrs.coordinates?.map((c) => c.y).join() === "40,12")).toBe(true);
		expect(texts.find((f) => f.attrs.text === "Long")?.attrs.y).toBe(40);
		expect(texts.find((f) => f.attrs.text === "+6.00 USD")?.attrs.y).toBe(12);
	});

	it("registers the order line as draggable and reports the drag end price", async () => {
		const { ORDER_LINE_NAME, registerOrderLineOverlay } = await import("@/lib/chart/order-line-overlay");

		registerOrderLineOverlay();

		const overlayConfig = registerOverlay.mock.calls[0]?.[0];
		expect(overlayConfig).toMatchObject({
			name: ORDER_LINE_NAME,
			lock: false,
			totalStep: 1,
		});
		expect(typeof overlayConfig?.onPressedMoveEnd).toBe("function");

		// Drag end reports the final point value to the extendData callback.
		const onDragEnd = vi.fn();
		const event = { x: 20, y: 40, overlay: { points: [{ value: 123.45 }], extendData: { onDragEnd } } };
		overlayConfig.onPressedMoveStart(event);
		overlayConfig.onPressedMoving({ ...event, y: 60 });
		const handled = overlayConfig.onPressedMoveEnd({ ...event, y: 60 });
		expect(handled).toBe(true);
		expect(onDragEnd).toHaveBeenCalledWith(123.45);

		// A cell tap is NOT a price drag: it must not start a Moving preview or
		// rebuild the overlay before the subsequent TIF/cancel click is dispatched.
		onDragEnd.mockClear();
		overlayConfig.onPressedMoveStart(event);
		overlayConfig.onPressedMoving({ ...event, y: 41 });
		overlayConfig.onPressedMoveEnd({ ...event, y: 41 });
		expect(onDragEnd).not.toHaveBeenCalled();

		// Invalid values (missing / non-positive) are ignored.
		const ignored = vi.fn();
		overlayConfig.onPressedMoveEnd({ overlay: { points: [{ value: 0 }], extendData: { onDragEnd: ignored } } });
		overlayConfig.onPressedMoveEnd({ overlay: { points: [{}], extendData: { onDragEnd: ignored } } });
		expect(ignored).not.toHaveBeenCalled();

		// Figures stay event-enabled so the engine can start a drag, including an invisible grab band.
		const figures = overlayConfig.createPointFigures({
			overlay: { extendData: { side: "B", label: "Limit Buy" }, points: [{ value: 100 }] },
			coordinates: [{ x: 0, y: 10 }],
			bounding: { width: 320 },
			precision: { price: 2 },
		});
		expect(figures.every((figure: { ignoreEvent?: boolean }) => figure.ignoreEvent !== true)).toBe(true);
		expect(
			figures.some(
				(figure: { type: string; styles?: { color?: string } }) =>
					figure.type === "line" && figure.styles?.color === "transparent",
			),
		).toBe(true);
	});
});

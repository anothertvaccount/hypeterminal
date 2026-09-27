import Big from "big.js";
import { type Overlay, type OverlayEvent, type OverlayFigure, registerOverlay, type YAxis } from "klinecharts";
import type { LineOverlayResolution } from "@/domain/trade/order/chart-labels";
import { noteChartOverlayInteraction } from "./overlay-interaction";
import { colorToHex, colorToRgba, getChartColors } from "./theme-colors";

/**
 * Shared renderer for chart trading lines. Each line draws as:
 *  - a dashed price line (grabbable when draggable/movable),
 *  - a bordered label strip floating in the left half of the pane (order / position
 *    info; never hugging the edge, never crossing the center),
 *  - a price badge on the right price axis.
 *
 * Interactive boxes declare a `key` ("cancel" | "tp" | "sl"); clicks and presses are
 * routed to the extendData callbacks below, resolved by figure key with a geometry
 * fallback against the layout computed during the last draw.
 *
 * A resolution may pin the row (`lineY`) and add a floating `ghost` row with a dashed
 * connector — the TP/SL drag preview, where the entry line never moves.
 */

export interface LabelBox {
	key?: string;
	x0: number;
	x1: number;
	y0: number;
	y1: number;
}

export interface LineOverlayExtendData {
	/** Called on every draw; returns the label segments for the current data. */
	getSegments: () => LineOverlayResolution;
	/**
	 * Full resolution (segments + pin/ghost) computed from the live overlay state —
	 * preferred over getSegments when present. Used by the position line so the entry
	 * row can stay pinned while the overlay's point tracks a TP/SL drag.
	 */
	getResolution?: (args: { pointValue?: number; y?: number; yAxis?: YAxis | null }) => LineOverlayResolution;
	/** Written by the renderer each draw — the hit regions of keyed boxes. */
	boxes?: LabelBox[];
	/** Drag release on a draggable line: the new price (order repricing). */
	onDragEnd?: (next: number) => void;
	/**
	 * Press start with the hit box key (figure key, geometry fallback). NOTE: the chart
	 * library ignores this callback's return value — gate movement in onPressMoving.
	 */
	onPressStart?: (key: string | undefined, event: OverlayEvent) => boolean;
	/** Movement tick: return true to CANCEL the point movement (line stays put). */
	onPressMoving?: (event: OverlayEvent) => boolean;
	/** Press release: read `event.overlay.points[0]` for the dropped price. */
	onPressEnd?: (event: OverlayEvent) => void;
	/** Click on a keyed box (e.g. the ✕ cancel button). */
	onClickBox?: (key: string, event: OverlayEvent) => void;
}

interface LineOverlayStyle {
	lineAlpha: number;
}

interface ResolveInput {
	extendData: unknown;
	overlay?: Overlay;
	y?: number;
	yAxis?: YAxis | null;
}

interface Config {
	name: string;
	style: LineOverlayStyle;
	resolve: (input: ResolveInput) => LineOverlayResolution;
	/** The line can be dragged; releases call extendData.onDragEnd with the new price. */
	draggable?: boolean;
	/** The line accepts press events (gesture feedback) but never reprices on release. */
	movable?: boolean;
}

const FONT_SIZE = 10;
const PADDING_X = 5;
const PADDING_Y = 2;
const BORDER_SIZE = 1;
/** Minimum breathing room from the pane's left edge; rows float left of center. */
const ROW_INSET = 20;
const LABEL_FONT = "500 10px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

let measureCtx: CanvasRenderingContext2D | null = null;
let measureTried = false;

/** Text width for box layout — real canvas metrics in the browser, safe fallback elsewhere. */
function measureLabelWidth(text: string): number {
	if (!measureTried) {
		measureTried = true;
		try {
			measureCtx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
		} catch {
			measureCtx = null;
		}
	}
	if (measureCtx) {
		try {
			measureCtx.font = LABEL_FONT;
			const width = measureCtx.measureText(text).width;
			if (Number.isFinite(width) && width > 0) return width;
		} catch {
			// fall through to the estimate
		}
	}
	return text.length * 6.4;
}

function getExtendData(event: OverlayEvent): LineOverlayExtendData | undefined {
	return event.overlay.extendData as LineOverlayExtendData | undefined;
}

function boxKeyAt(event: OverlayEvent): string | undefined {
	const boxes = getExtendData(event)?.boxes;
	if (!boxes || boxes.length === 0) return undefined;
	const fromFigure = event.figureKey;
	if (fromFigure && boxes.some((box) => box.key === fromFigure)) return fromFigure;
	const { x, y } = event;
	if (typeof x === "number" && typeof y === "number") {
		for (const box of boxes) {
			if (box.key && x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1) return box.key;
		}
	}
	return undefined;
}

/**
 * Stamp threshold: a press only counts as a drag (and consumes the chart-click
 * hotkey gesture) once it has moved further than the hotkey's own click-drift
 * window — sub-4px presses stay plain clicks, so hold-key + click spam keeps
 * placing orders even when clicks land on resting lines or preview strips.
 */
const DRAG_STAMP_PX = 4;
let pressOrigin: { x: number; y: number } | null = null;

export function createLineOverlay({ style, resolve, draggable = false, movable = false, ...config }: Config) {
	let registered = false;

	return function register() {
		if (registered) return;
		registered = true;

		const eventsOn = draggable || movable;

		registerOverlay({
			...config,
			needDefaultPointFigure: false,
			needDefaultXAxisFigure: false,
			needDefaultYAxisFigure: false,
			totalStep: 1,
			lock: !eventsOn,
			zLevel: -1,
			onClick: (event) => {
				const key = boxKeyAt(event);
				const data = getExtendData(event);
				// Stamp only presses that DO something (✕/TP/SL cells with handlers): a
				// plain press on a line body or preview chip must stay transparent to the
				// chart-click hotkeys — otherwise spamming hold+click over resting lines
				// silently drops every other order.
				if (key && data?.onClickBox) {
					noteChartOverlayInteraction();
					data.onClickBox(key, event);
				}
				return true;
			},
			onPressedMoveStart: (event) => {
				pressOrigin = typeof event.x === "number" && typeof event.y === "number" ? { x: event.x, y: event.y } : null;
				const extendData = getExtendData(event);
				const key = boxKeyAt(event);
				if (extendData?.onPressStart) return extendData.onPressStart(key, event);
				return draggable;
			},
			onPressedMoving: (event) => {
				// Stamp only once a REAL drag is underway (> the click-drift window):
				// the hotkey handler drops those gestures anyway, while small presses
				// remain plain clicks (rapid chart-click spam must not lose orders).
				if (
					pressOrigin &&
					typeof event.x === "number" &&
					typeof event.y === "number" &&
					Math.hypot(event.x - pressOrigin.x, event.y - pressOrigin.y) > DRAG_STAMP_PX
				) {
					noteChartOverlayInteraction();
				}
				return getExtendData(event)?.onPressMoving?.(event) ?? false;
			},
			onPressedMoveEnd: (event) => {
				pressOrigin = null;
				const extendData = getExtendData(event);
				extendData?.onPressEnd?.(event);
				if (draggable && extendData?.onDragEnd) {
					const value = event.overlay.points[0]?.value;
					if (typeof value === "number" && Number.isFinite(value) && value > 0) {
						extendData.onDragEnd(value);
					}
				}
				return true;
			},
			onRemoved: (event) => {
				if (import.meta.env.DEV) {
					// Keep the dev hit-region log in sync with the live overlays — scripts
					// then never match a removed overlay's stale record.
					const log = (
						globalThis as {
							__hlBoxLog?: Record<string, { name: string; value?: number; boxes: LabelBox[] }>;
						}
					).__hlBoxLog;
					if (log) delete log[event.overlay.id];
				}
				return true;
			},
			createPointFigures: ({ overlay, coordinates, bounding, yAxis }) => {
				const yPix = coordinates[0]?.y;
				if (yPix === undefined) return [];

				const extendData = overlay.extendData as LineOverlayExtendData | undefined;
				const resolution = extendData?.getResolution
					? extendData.getResolution({ pointValue: overlay.points[0]?.value, y: yPix, yAxis })
					: resolve({ extendData: overlay.extendData, overlay, y: yPix, yAxis });
				const { segments, isBuy, lineY, ghost } = resolution;
				// The drawn row can be pinned away from the live point (TP/SL drag: the
				// entry line stays put while the point tracks the pointer).
				const rowY = lineY ?? yPix;

				const colors = getChartColors();
				const green = colorToHex(colors.green);
				const red = colorToHex(colors.red);
				const bgColor = colorToHex(colors.background);
				const fgColor = colorToHex(colors.foreground);
				const marketColor = isBuy ? green : red;
				const lineColor = colorToRgba(marketColor, style.lineAlpha);
				const toneColor = (tone: string): string => {
					// PREVIEW drafts read as muted gray — never mistakable for a live side color.
					if (tone === "preview") return colorToHex(colors.textSecondary);
					return tone === "buy" || tone === "up" || tone === "tp" ? green : red;
				};

				const figures: OverlayFigure[] = [];
				// A thick invisible line widens the grab target on interactive lines.
				if (eventsOn) {
					figures.push({
						type: "line",
						attrs: {
							coordinates: [
								{ x: 0, y: rowY },
								{ x: bounding.width, y: rowY },
							],
						},
						styles: { style: "solid", color: "transparent", size: 12 },
					});
				}
				figures.push({
					type: "line",
					attrs: {
						coordinates: [
							{ x: 0, y: rowY },
							{ x: bounding.width, y: rowY },
						],
					},
					styles: { style: "dashed", color: lineColor, size: 1, dashedValue: [4, 3] },
					ignoreEvent: !eventsOn,
				});

				const boxes: LabelBox[] = [];
				const totalWidth = (widths: number[]) => widths.reduce((sum, w) => sum + w, 0);
				/** Cells sit flush inside one strip: text + horizontal padding, no gaps. */
				const measureCells = (rowSegments: typeof segments) =>
					rowSegments.map((segment) => measureLabelWidth(segment.text) + PADDING_X * 2);
				/**
				 * Floats the strip inside the LEFT HALF of the pane: inset from the edge,
				 * never crossing the center (best effort — a strip wider than half the pane
				 * falls back to the inset).
				 */
				const rowAnchor = (total: number, paneWidth: number) => Math.max(ROW_INSET, (paneWidth / 2 - total) / 2);
				/** Draws one bordered strip (photo style): bg+border rect, dividers, cell texts. */
				const drawStrip = (
					rowSegments: typeof segments,
					cellWidths: number[],
					anchorX: number,
					yRow: number,
					interactive: boolean,
					borderTone: string,
				): LabelBox[] => {
					const stripBoxes: LabelBox[] = [];
					const stripWidth = totalWidth(cellWidths);
					if (rowSegments.length === 0 || stripWidth <= 0) return stripBoxes;
					const boxHeight = FONT_SIZE + PADDING_Y * 2 + 4;
					const top = yRow - boxHeight / 2;

					// One continuous bordered strip behind the cells — the border the labels were missing.
					figures.push({
						type: "rect",
						attrs: { x: anchorX, y: top, width: stripWidth, height: boxHeight },
						styles: {
							style: "stroke_fill",
							color: bgColor,
							borderColor: borderTone,
							borderSize: BORDER_SIZE,
						},
						ignoreEvent: !eventsOn,
					});
					// Internal dividers between cells (photo style).
					let edge = anchorX;
					for (let i = 0; i < cellWidths.length - 1; i += 1) {
						edge += cellWidths[i];
						figures.push({
							type: "line",
							attrs: {
								coordinates: [
									{ x: edge, y: top + 1 },
									{ x: edge, y: top + boxHeight - 1 },
								],
							},
							styles: { style: "solid", color: borderTone, size: 1 },
							ignoreEvent: !eventsOn,
						});
					}
					// Cell texts: centered per cell; the strip draws all lines (cells stay borderless).
					let cursorX = anchorX;
					rowSegments.forEach((segment, index) => {
						const width = cellWidths[index];
						const color = toneColor(segment.tone);
						// Filled preview chips use the brand accent: gray-on-gray (fg on
						// textSecondary) would disappear into the strip.
						const filledBg = segment.filled && segment.tone === "preview" ? colorToHex(colors.accent) : color;
						figures.push({
							type: "text",
							attrs: {
								x: cursorX + width / 2,
								y: yRow,
								text: segment.text,
								align: "center",
								baseline: "middle",
							},
							styles: {
								color: segment.filled ? fgColor : color,
								size: FONT_SIZE,
								paddingLeft: PADDING_X,
								paddingRight: PADDING_X,
								paddingTop: PADDING_Y,
								paddingBottom: PADDING_Y,
								backgroundColor: segment.filled ? filledBg : "transparent",
								borderColor: "transparent",
								borderSize: 0,
								style: "fill",
							},
							...(segment.key ? { key: segment.key } : {}),
							ignoreEvent: !eventsOn,
						});
						if (interactive && segment.key) {
							stripBoxes.push({
								key: segment.key,
								x0: cursorX,
								x1: cursorX + width,
								y0: top - 2,
								y1: top + boxHeight + 2,
							});
						}
						cursorX += width;
					});
					return stripBoxes;
				};

				const mainWidths = measureCells(segments);
				const mainAnchor = rowAnchor(totalWidth(mainWidths), bounding.width);
				boxes.push(...drawStrip(segments, mainWidths, mainAnchor, rowY, true, isBuy ? green : red));
				if (extendData) extendData.boxes = boxes;
				if (import.meta.env.DEV) {
					// Debug affordance for browser test scripts: pixel hit-regions per overlay (dev builds only).
					const log =
						(
							globalThis as {
								__hlBoxLog?: Record<string, { name: string; value?: number; boxes: LabelBox[] }>;
							}
						).__hlBoxLog ?? {};
					log[overlay.id] = { name: config.name, value: overlay.points[0]?.value, boxes };
					(globalThis as { __hlBoxLog?: typeof log }).__hlBoxLog = log;
				}

				if (ghost) {
					const ghostColor = toneColor(ghost.segments[0]?.tone ?? (isBuy ? "buy" : "sell"));
					const ghostLine = colorToRgba(ghostColor, style.lineAlpha);
					// Dashed horizontal at the drop price (continues to the axis badge)…
					figures.push({
						type: "line",
						attrs: {
							coordinates: [
								{ x: 0, y: ghost.y },
								{ x: bounding.width, y: ghost.y },
							],
						},
						styles: { style: "dashed", color: ghostLine, size: 1, dashedValue: [4, 3] },
						ignoreEvent: !eventsOn,
					});
					// …and a vertical dashed connector from the tp/sl cell down/up to the strip.
					const anchorBox = boxes.find((box) => box.key === ghost.anchor);
					const connectorX = anchorBox ? (anchorBox.x0 + anchorBox.x1) / 2 : mainAnchor + 30;
					figures.push({
						type: "line",
						attrs: {
							coordinates: [
								{ x: connectorX, y: rowY },
								{ x: connectorX, y: ghost.y },
							],
						},
						styles: { style: "dashed", color: ghostLine, size: 1, dashedValue: [3, 3] },
						ignoreEvent: !eventsOn,
					});
					const ghostWidths = measureCells(ghost.segments);
					const ghostAnchor = rowAnchor(totalWidth(ghostWidths), bounding.width);
					drawStrip(ghost.segments, ghostWidths, ghostAnchor, ghost.y, false, ghostColor);
				}

				return figures;
			},
			createYAxisFigures: ({ overlay, coordinates, bounding, precision }) => {
				const y = coordinates[0]?.y;
				if (y === undefined) return [];

				const rawPrice = overlay.points[0]?.value;
				const priceText = rawPrice != null ? Big(rawPrice).toFixed(precision.price) : "";
				if (!priceText) return [];

				const { isBuy } = resolve({ extendData: overlay.extendData });
				const colors = getChartColors();
				const toneColor = colorToHex(isBuy ? colors.green : colors.red);
				const bgColor = colorToHex(colors.background);

				return [
					{
						type: "text",
						attrs: { x: bounding.width - 4, y, text: priceText, align: "right", baseline: "middle" },
						styles: {
							color: toneColor,
							size: FONT_SIZE,
							paddingLeft: PADDING_X,
							paddingRight: PADDING_X,
							paddingTop: PADDING_Y,
							paddingBottom: PADDING_Y,
							backgroundColor: bgColor,
							borderColor: toneColor,
							borderSize: BORDER_SIZE,
							style: "fill" as const,
						},
					},
				];
			},
		});
	};
}

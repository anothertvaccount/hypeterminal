import { SIZE_PERCENT_OPTIONS } from "@/config/trade";
import { formatPriceForOrder } from "@/domain/trade/orders";
import type { Side } from "@/lib/trade/types";

/** klinecharts' main candle pane id (PaneIdConstants.CANDLE — not exported from the package). */
export const CANDLE_PANE_ID = "candle_pane";

export interface AxisRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface WrapperRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface AxisMenuItem {
	side: Side;
	label: string;
}

/** The order forms the price-axis menu can prefill. */
export const AXIS_MENU_ITEMS: readonly AxisMenuItem[] = [
	{ side: "buy", label: "Limit Buy" },
	{ side: "sell", label: "Limit Sell" },
];

/**
 * True when the pointer (viewport coordinates) is over the price axis — optionally
 * including a zone extending left of the labels (covers hovering the cross, which
 * now sits on the pane side of the border).
 */
export function isOnPriceAxis(x: number, y: number, axis: AxisRect, leftExtension = 0): boolean {
	return x >= axis.left - leftExtension && x <= axis.right && y >= axis.top && y <= axis.bottom;
}

/** Cross button geometry (size-4 → 16px, so half = 8) and its gap from the axis border. */
export const CROSS_HALF = 8;
export const CROSS_PANE_GAP = 4;

/** Hover zone reaches this far LEFT of the axis — enough to cover the cross itself. */
export const CROSS_HOVER_EXTENSION = CROSS_HALF * 2 + CROSS_PANE_GAP;

/** Keep label cancel hitboxes (including the DOM's 6px touch expansion) clear of the axis cross. */
export const ORDER_LABEL_AXIS_GUTTER = CROSS_HOVER_EXTENSION + 12;

/**
 * Horizontal CENTER of the cross, wrapper-relative: just inside the **pane**, right
 * next to the axis border — never on the price-label strip, so interacting with it
 * can't hijack the axis' drag-to-scale/zoom behaviour.
 */
export function getCrossLeft(axis: AxisRect, wrapper: WrapperRect): number {
	return axis.left - wrapper.left - CROSS_HALF - CROSS_PANE_GAP;
}

/** Position-size percentages offered for axis-menu TP/SL placement (25/50/75/100). */
export const TPSL_PERCENTAGES: readonly number[] = SIZE_PERCENT_OPTIONS.filter((pct) => pct > 0);

/**
 * CSS `right` offset that places a menu's right edge just left of the axis:
 * wrapper width minus the axis inset, plus the gap.
 */
export function getMenuRightOffset(axis: AxisRect, wrapper: WrapperRect, gap = 8): number {
	return wrapper.width - (axis.left - wrapper.left) + gap;
}

/** Keeps a vertically-centered element (cross/menu) fully inside the wrapper. */
export function clampAxisY(y: number, height: number, margin: number): number {
	if (!Number.isFinite(y) || y < 0) return margin;
	const low = margin;
	const high = Math.max(margin, height - margin);
	return Math.min(Math.max(y, low), high);
}

/**
 * Converts a raw axis price into an order-form price string (Hyperliquid tick rules),
 * returning null when the price is unusable.
 */
export function resolveAxisPrice(raw: number): string | null {
	if (!Number.isFinite(raw) || raw <= 0) return null;
	const formatted = formatPriceForOrder(raw);
	return formatted === "0" ? null : formatted;
}

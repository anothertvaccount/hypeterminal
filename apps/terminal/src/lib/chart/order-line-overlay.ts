import type { LineOverlayResolution } from "@/domain/trade/order/chart-labels";
import { createLineOverlay, type LineOverlayExtendData } from "./create-line-overlay";

export const ORDER_LINE_NAME = "orderLine";

const EMPTY: LineOverlayResolution = { segments: [], isBuy: true };

export const registerOrderLineOverlay = createLineOverlay({
	name: ORDER_LINE_NAME,
	style: { lineAlpha: 0.35 },
	// Chart trading: order lines are grabbable (drag = reprice) and carry a ✕ cancel box.
	draggable: true,
	resolve: ({ extendData }) => {
		const data = extendData as LineOverlayExtendData | undefined;
		return data?.getSegments?.() ?? EMPTY;
	},
});

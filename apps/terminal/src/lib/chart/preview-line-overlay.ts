import type { LineOverlayResolution } from "@/domain/trade/order/chart-labels";
import { createLineOverlay, type LineOverlayExtendData } from "./create-line-overlay";

export const PREVIEW_LINE_NAME = "previewLine";

const EMPTY: LineOverlayResolution = { segments: [], isBuy: true };

/**
 * Form drafts: the limit / TP / SL lines of an unsubmitted order. Drawn fainter
 * than live orders; the labels state they are PREVIEW and not in the book until
 * submitted. Draggable like real order lines — but a release writes the form
 * field instead of repricing an exchange order.
 */
export const registerPreviewLineOverlay = createLineOverlay({
	name: PREVIEW_LINE_NAME,
	style: { lineAlpha: 0.22 },
	draggable: true,
	resolve: ({ extendData }) => {
		const data = extendData as LineOverlayExtendData | undefined;
		return data?.getSegments?.() ?? EMPTY;
	},
});

import type { LineOverlayResolution } from "@/domain/trade/order/chart-labels";
import { createLineOverlay, type LineOverlayExtendData } from "./create-line-overlay";

export const POSITION_LINE_NAME = "positionLine";

const EMPTY: LineOverlayResolution = { segments: [], isBuy: true };

export const registerPositionLineOverlay = createLineOverlay({
	name: POSITION_LINE_NAME,
	style: { lineAlpha: 0.5 },
	// Presses are accepted so the TP/SL buttons can start a press-drag gesture, but the
	// drawn entry row is PINNED (getResolution pins lineY during the drag — only the
	// overlay's point and the floating ghost chip follow the pointer) and non-button
	// presses cancel movement outright. A release never reprices the position line.
	movable: true,
	resolve: ({ extendData, overlay, y, yAxis }) => {
		const data = extendData as LineOverlayExtendData | undefined;
		if (data?.getResolution) {
			return data.getResolution({ pointValue: overlay?.points[0]?.value, y, yAxis });
		}
		return data?.getSegments?.() ?? EMPTY;
	},
});

import { createLineOverlay } from "./create-line-overlay";

export const LIQUIDATION_LINE_NAME = "liquidationLine";

export const registerLiquidationLineOverlay = createLineOverlay({
	name: LIQUIDATION_LINE_NAME,
	style: { lineAlpha: 0.5 },
	resolve: () => ({ segments: [{ text: "Liq.", tone: "sell" }], isBuy: false }),
});

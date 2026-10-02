import { t } from "@lingui/core/macro";
import { createValidator } from "../types";

export interface ReduceOnlyChaseContext {
	orderType: string;
	side: "buy" | "sell";
	reduceOnly?: boolean;
	/** Signed size in the selected market/dex; null while position data is unavailable. */
	reduceOnlyPositionSzi?: number | null;
}

export const reduceOnlyChaseValidator = createValidator<ReduceOnlyChaseContext>({
	id: "reduce-only-chase-position",
	code: "INP_006",
	category: "input",
	priority: 99,
	getMessage: (ctx) => {
		const size = ctx.reduceOnlyPositionSzi;
		if (size == null || !Number.isFinite(size)) return t`Waiting for position data to check Reduce Only`;
		if (size === 0) return t`Reduce Only needs an open position. Turn it off to open a trade.`;
		return size > 0 ? t`Choose Sell to reduce your long position.` : t`Choose Buy to reduce your short position.`;
	},
	validate: (ctx) => {
		if (!ctx.reduceOnly || ctx.orderType !== "chaseLimit") return true;
		const size = ctx.reduceOnlyPositionSzi;
		return size != null && Number.isFinite(size) && size !== 0 && (size > 0 ? ctx.side === "sell" : ctx.side === "buy");
	},
});

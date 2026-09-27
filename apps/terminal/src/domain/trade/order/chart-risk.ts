import type { ChartLabelContext, ChartOrder, LineOverlayResolution } from "@/domain/trade/order/chart-labels";
import {
	formatSignedUsd,
	formatUsd,
	orderFlagsText,
	orderTypeWord,
	realizedIfHit,
} from "@/domain/trade/order/chart-labels";
import { applyPaperFill, closedUnitsRemoved, type PaperPosition } from "@/lib/paper-trading";

/**
 * The risk half of the chart labels: the cumulative "as if everything nearer hit
 * first" scenario behind the second PnL number on each order line.
 *
 * Netting reuses the paper fill engine so the label always matches what trading
 * would actually do. Lives apart from ./chart-labels.ts because pulling in the
 * paper engine (and its Hyperliquid client imports) would weigh down every light
 * consumer of the label types and formatters.
 */

/**
 * Cumulative scenario at `level`: starting from the current mark, every open order
 * between the mark and `level` fills in price order (nearest first), then the account
 * is marked at `level`. Returns realized closes plus the PnL of the remaining
 * position — correct with or without an existing position. Null when the level is
 * unusable or no mark is known yet.
 */
export function cumulativePnlAt(
	level: number,
	orders: readonly ChartOrder[],
	position: ChartLabelPositionLike | null,
	mark: number | undefined,
): number | null {
	if (mark === undefined || !Number.isFinite(mark) || mark <= 0) return null;
	if (!Number.isFinite(level) || level <= 0) return null;
	if (level === mark) {
		return position ? position.szi * (level - position.entryPx) : 0;
	}

	const descending = level < mark;
	const onPath = orders
		.filter((order) => Number.isFinite(order.price) && order.price > 0 && order.size > 0)
		.filter((order) =>
			descending ? order.price <= mark && order.price >= level : order.price >= mark && order.price <= level,
		)
		.sort((a, b) => Math.abs(a.price - mark) - Math.abs(b.price - mark));

	const coin = position?.coin || "MKT";
	let szi = position?.szi ?? 0;
	let entryPx = position?.entryPx ?? 0;
	let realized = 0;

	for (const order of onPath) {
		const oldSzi = szi;
		// The entry the closing units were carried at — before this fill re-averages it.
		const entryAtFill = entryPx;
		const snapshot: PaperPosition = {
			assetId: 0,
			coin,
			...(position?.dex !== undefined ? { dex: position.dex } : {}),
			szi,
			entryPx,
			leverage: 1,
			marginMode: "cross",
		};
		const next = applyPaperFill([snapshot], {
			assetId: 0,
			coin,
			isBuy: order.side === "B",
			size: order.size,
			price: order.price,
			reduceOnly: order.reduceOnly,
			isTrigger: false,
			leverage: 1,
			marginMode: "cross",
		})[0];

		szi = next?.szi ?? 0;
		entryPx = next?.entryPx ?? 0;

		// Units that left the book realize against the entry they were carried at.
		realized += closedUnitsRemoved(oldSzi, szi) * (order.price - entryAtFill);
	}

	return realized + szi * (level - entryPx);
}

/** Structural alias so this module does not widen the label types. */
type ChartLabelPositionLike = NonNullable<ChartLabelContext["position"]>;

/** Segments for a resting order's chart label — type, [if-hit / cumulative], flags, size, ✕. */
export function buildOrderSegments(order: ChartOrder, ctx: ChartLabelContext): LineOverlayResolution {
	const tone = order.side === "B" ? ("buy" as const) : ("sell" as const);
	const mark = ctx.mark;
	let numbers = "";
	if (mark !== undefined) {
		const cumulative = cumulativePnlAt(order.price, ctx.orders, ctx.position, mark);
		const own = realizedIfHit(order, ctx.position);
		numbers = ` [${formatSignedUsd(own)} / ${formatSignedUsd(cumulative ?? 0)}]`;
	}
	return {
		isBuy: order.side === "B",
		segments: [
			{ text: `${orderTypeWord(order)}${numbers}${orderFlagsText(order)}`, tone },
			{ text: formatUsd(order.size * order.price), tone },
			{ text: "\u2715", tone, key: "cancel" },
		],
	};
}

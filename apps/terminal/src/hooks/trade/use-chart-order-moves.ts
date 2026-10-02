import { useEffect, useMemo } from "react";
import { useTradingSession } from "@/lib/hyperliquid";
import type { OpenOrder } from "@/lib/trade/open-orders";
import { mergeChartOrderMoves, useOrderMoveStore } from "@/stores/use-order-move-store";

/** Visual continuity only: account/Open Orders data stays authoritative. */
export function useChartOrderMoves(orders: OpenOrder[]) {
	const { address } = useTradingSession();
	const allMoves = useOrderMoveStore((state) => state.moves);
	const moves = useMemo(
		() => Object.fromEntries(Object.entries(allMoves).filter(([, move]) => !move.account || move.account === address)),
		[allMoves, address],
	);
	const drop = useOrderMoveStore((state) => state.drop);
	useEffect(() => {
		for (const [key, move] of Object.entries(moves)) {
			if (
				!move.pending &&
				!move.error &&
				orders.some(
					(row) =>
						row.oid === move.order.oid &&
						Number(row.limitPx) === Number(move.order.limitPx) &&
						row.tif === move.order.tif,
				)
			)
				drop(Number(key));
		}
	}, [orders, moves, drop]);
	return useMemo(() => mergeChartOrderMoves(orders, moves), [orders, moves]);
}

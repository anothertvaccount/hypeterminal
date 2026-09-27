import { useSubscription } from "@hypeterminal/hl-react";
import { useEffect } from "react";
import { HL_ALL_DEXS } from "@/config/app";
import { PAPER_TRADE } from "@/config/paper";
import { useOrderQueueActions } from "@/stores/use-order-queue-store";
import { usePaperActions, usePaperOpenOrders, usePaperPositions } from "@/stores/use-paper-store";

/**
 * Ticks the paper trading engine against live marks: a resting limit that the market
 * trades through leaves the book, becomes (or reduces) a simulated position, and queues
 * a fill toast. Safe to mount in multiple components — fillCrossedOrders is idempotent,
 * so only the first caller of a tick observes the fills (and toasts them).
 */
export function usePaperFills(): void {
	const actions = usePaperActions();
	const positions = usePaperPositions();
	const openOrders = usePaperOpenOrders();
	const { addOrder } = useOrderQueueActions();
	const enabled = PAPER_TRADE && (positions.length > 0 || openOrders.length > 0);
	const { data } = useSubscription("allMids", { dex: HL_ALL_DEXS }, { enabled });

	const marks = data?.mids;
	useEffect(() => {
		if (!marks) return;
		const crossed = actions.fillCrossedOrders(marks);
		for (const order of crossed) {
			addOrder({
				market: order.coin,
				side: order.isBuy ? "buy" : "sell",
				size: String(order.size),
				price: String(order.isTrigger ? (order.triggerPx ?? order.limitPx) : order.limitPx),
				orderType: order.isTrigger ? "trigger" : "limit",
				status: "success",
				outcome: "filled",
				completedAt: Date.now(),
			});
		}
	}, [marks, actions, addOrder]);
}

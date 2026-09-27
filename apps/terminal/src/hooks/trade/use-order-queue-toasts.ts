import { t } from "@lingui/core/macro";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useOrderQueue } from "@/stores/use-order-queue-store";

/**
 * Order-outcome toasts for surfaces with no order queue.
 *
 * Every submit result — placed, rejected, or the ambiguous "could not confirm"
 * case — is reported through the queue store, and the queue lives in the DESKTOP
 * order panel. On the phone nothing renders it, so a failed order (or a chase
 * whose post-only book read came back empty) used to fail completely silently:
 * the form pre-fills, no order appears in Open Orders, and the user is left
 * thinking the tap did nothing. This watches the queue and reports the outcome.
 *
 * Only rows that CHANGE while mounted are announced: the first render seeds the
 * seen-set so a reload doesn't replay yesterday's failures, and each row is
 * announced once (tracked by id + status).
 */
export function useOrderQueueToasts(): void {
	const orders = useOrderQueue();
	const seen = useRef<Map<string, string>>(new Map());
	const primed = useRef(false);

	useEffect(() => {
		const current = new Map<string, string>();
		for (const order of orders) current.set(order.id, order.status);

		// First pass after mount: remember what already exists, announce nothing.
		if (!primed.current) {
			primed.current = true;
			seen.current = current;
			return;
		}

		for (const order of orders) {
			const previous = seen.current.get(order.id);
			// Only transitions into a finished state are news.
			if (previous === order.status) continue;
			if (order.status === "failed") {
				toast.error(t`${order.side === "buy" ? "Buy" : "Sell"} ${order.market} failed`, {
					description: order.error ?? t`The exchange rejected the order.`,
				});
			} else if (order.status === "success" && order.orderType === "market") {
				// Market orders report their fill on the row; a resting limit/chase is
				// visible in Open Orders, so announcing those would be noise.
				toast.success(t`${order.side === "buy" ? "Bought" : "Sold"} ${order.market}`, {
					description: order.outcome === undefined ? undefined : String(order.outcome),
				});
			}
		}
		seen.current = current;
	}, [orders]);
}

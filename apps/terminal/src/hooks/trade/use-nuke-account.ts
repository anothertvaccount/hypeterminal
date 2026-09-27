import { useRef } from "react";
import { HL_ALL_DEXS } from "@/config/app";
import { PAPER_TRADE } from "@/config/paper";
import { useCancelOpenOrders } from "@/hooks/trade/use-cancel-open-orders";
import { type CloseAllResult, useCloseAllPositions } from "@/hooks/trade/use-close-all-positions";
import { useSubscription, useTradingSession } from "@/lib/hyperliquid";
import type { OpenOrder } from "@/lib/trade/open-orders";
import { usePaperOpenOrderRows } from "@/stores/use-paper-store";

export type NukeResult = CloseAllResult & { cancelled: number };

/**
 * The "nuke": cancel every resting order (all markets, including the active chase —
 * its engine retires cleanly) and close every position. Preview operates on the
 * simulated book; live hits the exchange. Used by the toolbar Nuke button after its
 * confirmation dialog.
 */
export function useNukeAccount(): () => Promise<NukeResult> {
	const { address, isActive } = useTradingSession();
	const cancelOpenOrders = useCancelOpenOrders();
	const closeAllPositions = useCloseAllPositions();
	const paperRows = usePaperOpenOrderRows();

	const { data: openOrdersEvent } = useSubscription(
		"openOrders",
		{ user: address ?? "0x0", dex: HL_ALL_DEXS },
		{ enabled: !PAPER_TRADE && isActive },
	);
	const ordersRef = useRef<OpenOrder[]>([]);
	ordersRef.current = PAPER_TRADE ? paperRows : (openOrdersEvent?.orders ?? []);

	return async () => {
		const orders = ordersRef.current;
		// Cancel failures must not be reported as cancellations — the dialog lists
		// them so the user knows resting orders may remain (closing proceeds anyway:
		// flattening reduces risk even if a cancel batch failed).
		const cancelResult = orders.length > 0 ? await cancelOpenOrders(orders) : { cancelled: 0, errors: [] };
		const { closed, errors: closeErrors } = await closeAllPositions();
		return { cancelled: cancelResult.cancelled, closed, errors: [...cancelResult.errors, ...closeErrors] };
	};
}

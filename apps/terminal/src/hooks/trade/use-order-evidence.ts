import type { OpenOrdersWsEvent, OrderUpdatesWsEvent } from "@nktkas/hyperliquid";
import { useCallback, useEffect } from "react";
import { HL_ALL_DEXS } from "@/config/app";
import { PAPER_TRADE } from "@/config/paper";
import {
	serializeKey,
	subscriptionKeys,
	useHyperliquid,
	useHyperliquidStoreApi,
	useSubscription,
	useTradingSession,
} from "@/lib/hyperliquid";
import { orderEvidence, orderEvidenceScope } from "@/lib/trade/order-evidence";

/** Root chart actions keep this mounted even when cancellation removes a row. */
export function useOrderEvidence() {
	const { info } = useHyperliquid();
	const { address } = useTradingSession();
	const store = useHyperliquidStoreApi();
	const scope = orderEvidenceScope(info, address ?? "0x0");
	const updatesKey = serializeKey(subscriptionKeys.method("orderUpdates", { user: address ?? "0x0" }));
	const openKey = serializeKey(subscriptionKeys.method("openOrders", { user: address ?? "0x0", dex: HL_ALL_DEXS }));
	useSubscription(
		"orderUpdates",
		{ user: address ?? "0x0" },
		{ enabled: !PAPER_TRADE && !!address, pauseWhenHidden: false },
	);
	useSubscription("openOrders", { user: address ?? "0x0", dex: HL_ALL_DEXS }, { enabled: !PAPER_TRADE && !!address });
	useEffect(() => {
		if (!address || PAPER_TRADE) return;
		let lastOpen: unknown;
		// Observe every store delivery: React may combine renders and skip an intermediate batch.
		const publish = () => {
			const subscriptions = store.getState().subscriptions;
			const updates = subscriptions[updatesKey]?.data as OrderUpdatesWsEvent | undefined;
			if (updates) orderEvidence.ingestUpdates(scope, updates);
			const open = subscriptions[openKey]?.data as OpenOrdersWsEvent | undefined;
			if (open && open !== lastOpen && open.user.toLowerCase() === address.toLowerCase()) {
				lastOpen = open;
				orderEvidence.ingestOpen(scope, open.orders);
			}
		};
		const unsubscribe = store.subscribe(publish);
		publish();
		return unsubscribe;
	}, [address, scope, store, updatesKey, openKey]);
	const updatesReady = useCallback(
		() => store.getState().subscriptions[updatesKey]?.status === "active",
		[store, updatesKey],
	);
	return { scope, updatesReady };
}

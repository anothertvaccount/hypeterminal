import { useEffect } from "react";
import { orderMode } from "@/domain/trade/order/time-in-force";
import type { OpenOrder } from "@/lib/trade/open-orders";
import { useOrderMoveStore } from "@/stores/use-order-move-store";
import { useTifOverrideStore } from "@/stores/use-tif-override-store";

/** Shared chart/table state. A requested type stays explicitly pending until read back. */
export function useOrderTifStatus(
	order: (Pick<OpenOrder, "oid" | "tif"> & Partial<Pick<OpenOrder, "isTrigger" | "orderType">>) | undefined,
) {
	const override = useTifOverrideStore((state) => (order ? state.overrides[order.oid] : undefined));
	const pending = useTifOverrideStore((state) => (order ? state.pending[order.oid] : undefined));
	const error = useTifOverrideStore((state) => (order ? state.errors[order.oid] : undefined));
	const moving = useOrderMoveStore((state) =>
		order ? Object.values(state.moves).some((move) => move.pending && move.order.oid === order.oid) : false,
	);
	const preview = useOrderMoveStore((state) =>
		order ? Object.values(state.moves).some((move) => move.order.oid === order.oid) : false,
	);
	const clearIfAgrees = useTifOverrideStore((state) => state.clearIfAgrees);
	useEffect(() => {
		if (order && pending === undefined && !preview) clearIfAgrees(order.oid, orderMode(order));
	}, [order, clearIfAgrees, pending, preview]);
	return { tif: override ?? (order && orderMode(order)), pending, error, moving };
}

import { t } from "@lingui/core/macro";
import { orderMode, tifLabel } from "@/domain/trade/order/time-in-force";
import { useOrderTifStatus } from "@/hooks/trade/use-order-tif-status";
import type { OpenOrder } from "@/lib/trade/open-orders";

/** Actual/confirmed TIF, kept separate from a requested change and its errors. */
export function OrderTifStatus({ order }: { order: OpenOrder }) {
	const { tif, pending, error } = useOrderTifStatus(order);
	return (
		<span data-order-tif={order.oid} className="block text-left" aria-busy={pending !== undefined}>
			<span className="text-xs font-semibold text-fg">{tifLabel(pending ? orderMode(order) : tif)}</span>
			{pending && <span className="block text-2xs text-fg-muted">{t`Changing to ${tifLabel(pending)}…`}</span>}
			{error && <output className="block whitespace-normal text-2xs text-error">{error}</output>}
		</span>
	);
}

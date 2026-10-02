import type { ChartOrderMode } from "@/domain/trade/order/time-in-force";
import type { TpSlOrigin } from "@/stores/use-tpsl-origin-store";
import type { OpenOrder } from "./open-orders";
import { matchingOrderIdentity, matchingRestingOrder } from "./order-evidence";

export function sameOrderExecution(a: OpenOrder, b: OpenOrder) {
	return (
		a.isTrigger === b.isTrigger &&
		a.reduceOnly === b.reduceOnly &&
		(!a.isTrigger ||
			(a.orderType === b.orderType &&
				Number(a.triggerPx) === Number(b.triggerPx) &&
				a.isPositionTpsl === b.isPositionTpsl &&
				(Number(a.origSz) === 0) === (Number(b.origSz) === 0)))
	);
}

export function replacementRow(
	source: OpenOrder,
	mode: ChartOrderMode,
	price: string,
	size: string,
	origin?: TpSlOrigin,
): OpenOrder {
	const trigger = mode === "TriggerMarket";
	return {
		...source,
		limitPx: price,
		sz: size,
		origSz: size,
		children: [],
		isTrigger: trigger,
		triggerPx: trigger ? price : "0",
		triggerCondition: trigger ? ((origin?.tpsl === "tp") !== (source.side === "B") ? ">=" : "<=") : "",
		isPositionTpsl: trigger && origin?.positionTpsl === true,
		orderType: trigger ? (origin?.tpsl === "tp" ? "Take Profit Market" : "Stop Market") : "Limit",
		tif: trigger ? null : mode,
	};
}

export function matchesReplacement(
	row: OpenOrder | undefined,
	expected: OpenOrder,
	mode: ChartOrderMode,
	size: string,
	cloid: string,
	fullPositionSize = 0,
): row is OpenOrder {
	if (mode !== "TriggerMarket") return matchingRestingOrder(row, expected, mode, expected.limitPx, size, cloid);
	if (
		!row ||
		!matchingOrderIdentity(row, expected, expected.limitPx, cloid) ||
		!sameOrderExecution(row, expected) ||
		row.children.length
	)
		return false;
	return Number(size) === 0
		? Number(row.origSz) === 0 &&
				Number.isFinite(Number(row.sz)) &&
				Number(row.sz) >= 0 &&
				Number(row.sz) <= fullPositionSize
		: Number(row.sz) > 0 && Number(row.sz) <= Number(size) && Number(row.origSz) === Number(size);
}

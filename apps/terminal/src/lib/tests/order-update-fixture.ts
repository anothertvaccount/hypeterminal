import type { OrderUpdatesWsEvent } from "@nktkas/hyperliquid";
import type { OpenOrder } from "@/lib/trade/open-orders";

/** The basic stream row omits frontend-only metadata and uses optional true for reduce-only. */
export function orderUpdateRow(row: OpenOrder): OrderUpdatesWsEvent[number]["order"] {
	return {
		coin: row.coin,
		side: row.side,
		limitPx: row.limitPx,
		sz: row.sz,
		oid: row.oid,
		timestamp: row.timestamp,
		origSz: row.origSz,
		...(row.cloid ? { cloid: row.cloid } : {}),
		...(row.reduceOnly ? { reduceOnly: true } : {}),
	};
}

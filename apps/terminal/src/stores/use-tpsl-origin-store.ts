import { z } from "zod";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { PAPER_TRADE } from "@/config/paper";
import { getNetwork } from "@/lib/network";
import { createValidatedStorage } from "@/lib/storage/validated-storage";
import type { OpenOrder } from "@/lib/trade/open-orders";

const originSchema = z.object({
	scope: z.string(),
	oid: z.number().int().positive(),
	coin: z.string(),
	side: z.enum(["B", "A"]),
	cloid: z.string().nullable(),
	tpsl: z.enum(["tp", "sl"]),
	fullPosition: z.boolean(),
	positionTpsl: z.boolean(),
});
export type TpSlOrigin = z.infer<typeof originSchema>;
const storage = createValidatedStorage(
	z.object({ state: z.object({ origins: z.record(z.string(), originSchema) }) }),
	"TP/SL origins",
);

export function tpSlScope(address?: string) {
	return `${PAPER_TRADE ? "paper" : "live"}:${getNetwork()}:${address?.toLowerCase() ?? "none"}`;
}

export function triggerOrigin(order: OpenOrder, scope: string): TpSlOrigin | undefined {
	if (!order.isTrigger || !order.reduceOnly || !/^(Take Profit|Stop) Market$/.test(order.orderType)) return;
	return {
		scope,
		oid: order.oid,
		coin: order.coin,
		side: order.side,
		cloid: order.cloid ?? null,
		tpsl: order.orderType.startsWith("Take Profit") ? "tp" : "sl",
		fullPosition: (order.isPositionTpsl || PAPER_TRADE) && Number(order.origSz) === 0,
		positionTpsl: order.isPositionTpsl,
	};
}

export function findTpSlOrigin(order: OpenOrder, scope: string, origins = useTpSlOriginStore.getState().origins) {
	return Object.values(origins).find(
		(origin) =>
			origin.scope === scope &&
			origin.coin === order.coin &&
			origin.side === order.side &&
			order.reduceOnly &&
			(origin.oid === order.oid || (origin.cloid !== null && origin.cloid === order.cloid)) &&
			(origin.cloid === null || !order.cloid || origin.cloid === order.cloid),
	);
}

interface State {
	origins: Record<string, TpSlOrigin>;
	remember: (origin: TpSlOrigin, row: OpenOrder) => void;
	transfer: (scope: string, source: OpenOrder, row: OpenOrder) => void;
}

/** Intent only: never contributes orders or quantities to account state. */
export const useTpSlOriginStore = create<State>()(
	persist(
		(set, get) => ({
			origins: {},
			remember: (origin, row) =>
				set((state) => {
					const origins = {
						...state.origins,
						[`${origin.scope}:${row.oid}`]: { ...origin, oid: row.oid, cloid: row.cloid ?? null },
					};
					for (const key of Object.keys(origins).slice(0, -512)) delete origins[key];
					return { origins };
				}),
			transfer: (scope, source, row) => {
				const origin = findTpSlOrigin(source, scope, get().origins);
				if (origin) get().remember(origin, row);
			},
		}),
		{
			name: "hypeterminal-tpsl-origins",
			storage: createJSONStorage(() => storage),
			partialize: (state) => ({ origins: state.origins }),
		},
	),
);

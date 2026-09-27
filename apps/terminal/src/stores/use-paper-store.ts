import { useMemo } from "react";
import { z } from "zod";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/config/app";
import { playActionSound } from "@/lib/fill-sound";
import {
	applyPaperFill,
	collectPaperFills,
	type PaperFill,
	type PaperOpenOrder,
	type PaperPosition,
	paperRealizedForFill,
	restingExecutionPrice,
	seedPaperOid,
	toOpenOrder,
} from "@/lib/paper-trading";
import { createValidatedStorage } from "@/lib/storage/validated-storage";
import type { OpenOrder } from "@/lib/trade/open-orders";
import { emitFillNotifications, type FillNotificationInput } from "@/stores/use-fill-notifications-store";

/** Keeps the transient oid→outcome cache bounded (oldest keys dropped). */
function pruneOutcomes(map: Record<number, "filled" | "cancelled">): void {
	const keys = Object.keys(map);
	if (keys.length > 40) {
		for (const key of keys.slice(0, keys.length - 40)) {
			delete map[Number(key)];
		}
	}
}

function fillToInput(fill: PaperFill): FillNotificationInput {
	return {
		side: fill.isBuy ? "buy" : "sell",
		market: fill.coin,
		size: String(fill.size),
		price: String(fill.price),
		kind: fill.isTrigger ? "Trigger" : "Market",
	};
}

// Persisted shape is validated on read; anything malformed is discarded rather than
// resurrected as a corrupt preview account.
const paperPersistSchema = z.object({
	state: z.object({
		positions: z.array(z.unknown()),
		openOrders: z.array(z.unknown()),
		realizedUsd: z.number().optional(),
	}),
});

const paperStorage = createValidatedStorage(paperPersistSchema, "paper trading store");

interface PaperTradingState {
	positions: PaperPosition[];
	openOrders: PaperOpenOrder[];
	/** Realized PnL from closed preview trades — credited/debited to the simulated balance. */
	realizedUsd: number;
	/** Transient: how recent order ids ended (feeds the chase tab's history). */
	outcomeByOid: Record<number, "filled" | "cancelled">;
	actions: {
		applyFill: (fill: PaperFill) => void;
		applyPlan: (fills: PaperFill[], resting: PaperOpenOrder[]) => void;
		/** Chart drag: moves a resting limit to a new price. */
		repriceOrder: (oid: number, limitPx: number) => void;
		cancelOrders: (oids: readonly number[]) => void;
		/**
		 * Checks live marks against the resting book, moves crossed orders off it,
		 * and returns the fills so the caller can toast them. Idempotent: a second
		 * call with the same marks finds an empty crossing set and returns [].
		 */
		fillCrossedOrders: (marks: Record<string, string>) => PaperOpenOrder[];
		reset: () => void;
	};
}

export const usePaperTradingStore = create<PaperTradingState>()(
	persist(
		(set, get) => ({
			positions: [],
			openOrders: [],
			realizedUsd: 0,
			outcomeByOid: {},
			actions: {
				applyFill: (fill) => {
					const state = get();
					const positions = applyPaperFill(state.positions, fill);
					const realized = paperRealizedForFill(state.positions, positions, fill);
					set({ positions, realizedUsd: state.realizedUsd + realized });
					// Top-right fill popup + chime (engine fills notify from fillCrossedOrders).
					if (!fill.isTrigger) emitFillNotifications([fillToInput(fill)]);
				},
				applyPlan: (fills, resting) => {
					const state = get();
					let positions = state.positions;
					let realized = 0;
					for (const fill of fills) {
						const next = applyPaperFill(positions, fill);
						realized += paperRealizedForFill(positions, next, fill);
						positions = next;
					}
					set({
						positions,
						realizedUsd: state.realizedUsd + realized,
						openOrders: resting.length > 0 ? [...state.openOrders, ...resting] : state.openOrders,
					});
					// Only executable legs filled; spot/trigger acknowledgements notify nothing.
					const filled = fills.filter((fill) => !fill.isTrigger);
					if (filled.length > 0) emitFillNotifications(filled.map(fillToInput));
					// A resting limit/trigger just hit the book — dry tick, not the fill chime.
					if (resting.length > 0) playActionSound();
				},
				repriceOrder: (oid, limitPx) => {
					if (!Number.isFinite(limitPx) || limitPx <= 0) return;
					set((state) => ({
						openOrders: state.openOrders.map((order) => {
							if (order.oid !== oid) return order;
							// Trigger lines (TP/SL/stops) reprice their trigger price; keep the
							// displayed limit value in step for tables.
							if (order.isTrigger) return { ...order, triggerPx: limitPx, limitPx };
							return { ...order, limitPx };
						}),
					}));
				},
				cancelOrders: (oids) => {
					if (oids.length === 0) return;
					playActionSound();
					set((state) => {
						const drop = new Set(oids);
						const outcomeByOid = { ...state.outcomeByOid };
						for (const oid of oids) outcomeByOid[oid] = "cancelled";
						pruneOutcomes(outcomeByOid);
						return {
							openOrders: state.openOrders.filter((order) => !drop.has(order.oid)),
							outcomeByOid,
						};
					});
				},
				fillCrossedOrders: (marks) => {
					const state = get();
					if (state.openOrders.length === 0) return [];
					const result = collectPaperFills(state.positions, state.openOrders, marks);
					if (result.filled.length === 0) return [];
					const outcomeByOid = { ...state.outcomeByOid };
					for (const row of result.filled) outcomeByOid[row.oid] = "filled";
					pruneOutcomes(outcomeByOid);
					set({
						positions: result.positions,
						openOrders: result.remaining,
						realizedUsd: state.realizedUsd + result.realized,
						outcomeByOid,
					});
					emitFillNotifications(
						result.filled.map((order) => ({
							side: order.isBuy ? ("buy" as const) : ("sell" as const),
							market: order.coin,
							size: String(order.size),
							price: String(restingExecutionPrice(order, marks)),
							kind: order.isTrigger ? (order.tpsl === "tp" ? "TP" : order.tpsl === "sl" ? "SL" : "Trigger") : "Limit",
						})),
					);
					return result.filled;
				},
				// Persisted state is replaced wholesale: positions, orders and realized PnL
				// all reset together (the account restarts at the base balance).
				reset: () => set({ positions: [], openOrders: [], realizedUsd: 0 }),
			},
		}),
		{
			name: STORAGE_KEYS.PAPER_TRADING,
			version: 1,
			storage: createJSONStorage(() => paperStorage),
			partialize: (state) => ({
				positions: state.positions,
				openOrders: state.openOrders,
				realizedUsd: state.realizedUsd,
			}),
			onRehydrateStorage: () => (state) => {
				// Allocated oids start low in a fresh session — never reuse ids that
				// persisted orders already own.
				if (!state) return;
				for (const order of state.openOrders) seedPaperOid(order.oid);
			},
		},
	),
);

if (import.meta.env.DEV) {
	// Debug affordance for browser test scripts (dev builds only).
	(globalThis as { __hlPaper?: typeof usePaperTradingStore }).__hlPaper = usePaperTradingStore;
}

export function usePaperPositions(): PaperPosition[] {
	return usePaperTradingStore((state) => state.positions);
}

export function usePaperOpenOrders(): PaperOpenOrder[] {
	return usePaperTradingStore((state) => state.openOrders);
}

export function usePaperRealizedUsd(): number {
	return usePaperTradingStore((state) => state.realizedUsd);
}

/** Resting paper orders in the SDK OpenOrder shape, memoized for table/chart consumers. */
export function usePaperOpenOrderRows(): OpenOrder[] {
	const orders = usePaperOpenOrders();
	return useMemo(() => orders.map(toOpenOrder), [orders]);
}

export function usePaperActions(): PaperTradingState["actions"] {
	return usePaperTradingStore((state) => state.actions);
}

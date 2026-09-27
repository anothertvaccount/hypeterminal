import { z } from "zod";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/config/app";
import type { ChaseEntry, ChaseOutcome } from "@/domain/trade/order/chase";
import { createValidatedStorage } from "@/lib/storage/validated-storage";

/**
 * Active chase (transient — a refresh mid-chase leaves the resting order alone
 * rather than resuming a stale loop) plus a persisted history of completed chases
 * shown in the Chase tab.
 */

export interface ChaseHistoryRecord {
	/** Unique per chase (placement time). */
	id: string;
	coin: string;
	side: "buy" | "sell";
	size: string;
	reduceOnly: boolean;
	startedAt: number;
	endedAt: number;
	outcome: ChaseOutcome;
	/** Last known resting price of the order. */
	price?: string;
}

const HISTORY_CAP = 100;

const chasePersistSchema = z.object({
	state: z.object({
		history: z.array(z.unknown()),
	}),
});
const chaseStorage = createValidatedStorage(chasePersistSchema, "chase orders");

interface ChaseOrderState {
	entry: ChaseEntry | null;
	history: ChaseHistoryRecord[];
	actions: {
		start: (entry: ChaseEntry) => void;
		clear: () => void;
		pushHistory: (record: Omit<ChaseHistoryRecord, "id">) => void;
		clearHistory: () => void;
	};
}

export const useChaseOrderStore = create<ChaseOrderState>()(
	persist(
		(set) => ({
			entry: null,
			history: [],
			actions: {
				start: (entry) => set({ entry }),
				clear: () => set({ entry: null }),
				pushHistory: (record) =>
					set((state) => ({
						history: [{ ...record, id: `chase-${record.startedAt}` }, ...state.history].slice(0, HISTORY_CAP),
					})),
				clearHistory: () => set({ history: [] }),
			},
		}),
		{
			name: STORAGE_KEYS.CHASE_ORDERS,
			version: 1,
			storage: createJSONStorage(() => chaseStorage),
			// Only history persists; the active chase stays transient by design.
			partialize: (state) => ({ history: state.history }),
		},
	),
);

if (import.meta.env.DEV) {
	// Debug affordance for browser test scripts (dev builds only).
	(globalThis as { __hlChase?: typeof useChaseOrderStore }).__hlChase = useChaseOrderStore;
}

export function useChaseEntry(): ChaseEntry | null {
	return useChaseOrderStore((state) => state.entry);
}

export function useChaseHistory(): ChaseHistoryRecord[] {
	return useChaseOrderStore((state) => state.history);
}

export function useChaseOrderActions(): ChaseOrderState["actions"] {
	return useChaseOrderStore((state) => state.actions);
}

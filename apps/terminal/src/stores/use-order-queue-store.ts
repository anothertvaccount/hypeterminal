import { create } from "zustand";
import type { OrderOutcome } from "@/lib/trade/extract-order-status";

export interface OrderQueueItem {
	id: string;
	market: string;
	side: "buy" | "sell";
	size: string;
	price?: string;
	orderType?: "market" | "limit" | "trigger" | "scale" | "twap";
	/** Chase retries do not surface failed rows in the queue or its toast watcher. */
	source?: "chase";
	tpPrice?: string;
	slPrice?: string;
	status: "pending" | "success" | "failed";
	outcome?: OrderOutcome;
	error?: string;
	createdAt: number;
	completedAt?: number;
}

interface OrderQueueStore {
	orders: OrderQueueItem[];
	actions: {
		addOrder: (order: Omit<OrderQueueItem, "id" | "createdAt">) => string;
		updateOrder: (id: string, update: Partial<Omit<OrderQueueItem, "id">>) => void;
		removeOrder: (id: string) => void;
	};
}

let orderIdCounter = 0;

function generateOrderId(): string {
	return `order-${Date.now()}-${++orderIdCounter}`;
}

const useOrderQueueStore = create<OrderQueueStore>()((set) => ({
	orders: [],
	actions: {
		addOrder: (order) => {
			const id = generateOrderId();
			if (order.source === "chase" && order.status === "failed") return id;
			const newOrder: OrderQueueItem = {
				...order,
				id,
				createdAt: Date.now(),
			};
			set((state) => ({
				orders: [...state.orders, newOrder],
			}));
			return id;
		},
		updateOrder: (id, update) => {
			set((state) => ({
				orders: state.orders
					.map((order) =>
						order.id === id
							? {
									...order,
									...update,
									completedAt:
										update.status === "success" || update.status === "failed" ? Date.now() : order.completedAt,
								}
							: order,
					)
					.filter((order) => order.source !== "chase" || order.status !== "failed"),
			}));
		},
		removeOrder: (id) => {
			set((state) => ({
				orders: state.orders.filter((order) => order.id !== id),
			}));
		},
	},
}));

if (import.meta.env.DEV) {
	// Debug affordance for browser test scripts (dev builds only).
	(globalThis as { __hlQueue?: typeof useOrderQueueStore }).__hlQueue = useOrderQueueStore;
}

export function useOrderQueue() {
	return useOrderQueueStore((state) => state.orders);
}

export function useOrderQueueActions() {
	return useOrderQueueStore((state) => state.actions);
}

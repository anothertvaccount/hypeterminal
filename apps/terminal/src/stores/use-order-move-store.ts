import { create } from "zustand";
import type { OpenOrder } from "@/lib/trade/open-orders";
import { useTifOverrideStore } from "./use-tif-override-store";

export interface OrderMove {
	order: OpenOrder;
	hiddenOids: number[];
	pending: boolean;
	kind?: "move" | "type";
	error?: string;
	account?: string;
}
interface MoveState {
	moves: Record<number, OrderMove>;
	timers: Record<number, ReturnType<typeof setTimeout>>;
	begin: (order: OpenOrder, price: string, account?: string, kind?: "move" | "type") => boolean;
	track: (oid: number, order: OpenOrder) => void;
	settle: (oid: number, order: OpenOrder) => void;
	fail: (oid: number, message: string) => void;
	drop: (oid: number) => void;
	isMoving: (oid: number) => boolean;
}
/** Chart-only previews, NOT resting orders. Never feed them into account/order counts. */
export const useOrderMoveStore = create<MoveState>((set, get) => ({
	moves: {},
	timers: {},
	isMoving: (oid) =>
		Object.entries(get().moves).some(
			([key, move]) => (move.pending || !!move.error) && (Number(key) === oid || move.order.oid === oid),
		),
	begin: (order, price, account, kind = "move") => {
		if (get().isMoving(order.oid)) return false;
		let hiddenOids = [order.oid];
		if (get().moves[order.oid]) {
			hiddenOids = [...new Set([...hiddenOids, ...get().moves[order.oid].hiddenOids])];
			get().drop(order.oid);
		}
		for (const [key, move] of Object.entries(get().moves)) {
			if (move.order.oid === order.oid) {
				hiddenOids = [...new Set([...hiddenOids, ...move.hiddenOids])];
				get().drop(Number(key));
			}
		}
		const timer = setTimeout(() => {
			const message = "Order move is not confirmed. Check Open Orders before retrying.";
			get().fail(order.oid, message);
			useTifOverrideStore.getState().fail(order.oid, message);
		}, 45_000);
		set((state) => ({
			moves: {
				...state.moves,
				[order.oid]: { order: { ...order, limitPx: price }, hiddenOids, pending: true, account, kind },
			},
			timers: { ...state.timers, [order.oid]: timer },
		}));
		return true;
	},
	track: (oid, order) => {
		set((state) => (state.moves[oid] ? { moves: { ...state.moves, [oid]: { ...state.moves[oid], order } } } : state));
	},
	settle: (oid, order) => {
		const move = get().moves[oid];
		if (!move) return;
		clearTimeout(get().timers[oid]);
		const timer = setTimeout(() => get().drop(oid), 10_000);
		set((state) => ({
			moves: { ...state.moves, [oid]: { ...move, order, pending: false } },
			timers: { ...state.timers, [oid]: timer },
		}));
	},
	fail: (oid, message) => {
		const move = get().moves[oid];
		if (!move) return;
		clearTimeout(get().timers[oid]);
		const timer = setTimeout(() => get().drop(oid), 60_000);
		set((state) => ({
			moves: { ...state.moves, [oid]: { ...move, pending: false, error: message } },
			timers: { ...state.timers, [oid]: timer },
		}));
	},
	drop: (oid) => {
		clearTimeout(get().timers[oid]);
		set((state) => {
			const moves = { ...state.moves };
			const timers = { ...state.timers };
			delete moves[oid];
			delete timers[oid];
			return { moves, timers };
		});
	},
}));

export function mergeChartOrderMoves(orders: OpenOrder[], moves: Record<number, OrderMove>): OpenOrder[] {
	const hidden = new Set(Object.values(moves).flatMap((move) => [...move.hiddenOids, move.order.oid]));
	return [...orders.filter((order) => !hidden.has(order.oid)), ...Object.values(moves).map((move) => move.order)];
}

import { create } from "zustand";
import type { ChartOrderMode } from "@/domain/trade/order/time-in-force";

/** Shared across chart row remounts. Requested TIF is not exchange confirmation. */
interface TifOverrideState {
	overrides: Record<number, ChartOrderMode>;
	pending: Record<number, ChartOrderMode>;
	errors: Record<number, string>;
	timers: Record<number, ReturnType<typeof setTimeout>>;
	setOverride: (oid: number, tif: ChartOrderMode) => void;
	confirm: (oid: number, tif: ChartOrderMode) => void;
	fail: (oid: number, message: string) => void;
	clearIfAgrees: (oid: number, authoritativeTif: string | null | undefined) => void;
	drop: (oid: number) => void;
}

export const useTifOverrideStore = create<TifOverrideState>((set, get) => ({
	overrides: {},
	pending: {},
	errors: {},
	timers: {},
	setOverride: (oid, tif) => {
		get().drop(oid);
		const timer = setTimeout(() => {
			get().fail(oid, "Order type change is not confirmed. Check Open Orders before retrying.");
		}, 45_000); // Covers both exchange writes and their bounded read-backs.
		set((state) => ({
			overrides: { ...state.overrides, [oid]: tif },
			pending: { ...state.pending, [oid]: tif },
			timers: { ...state.timers, [oid]: timer },
		}));
	},
	confirm: (oid, tif) => {
		get().drop(oid);
		// This value came from orderStatus, not from the requested TIF. Keep it until
		// the websocket agrees; a stale snapshot must not silently undo confirmation.
		set((state) => ({ overrides: { ...state.overrides, [oid]: tif } }));
	},
	fail: (oid, message) => {
		get().drop(oid);
		set((state) => ({ errors: { ...state.errors, [oid]: message } }));
	},
	clearIfAgrees: (oid, authoritativeTif) => {
		if (get().pending[oid] !== undefined) return;
		const override = get().overrides[oid];
		if (override !== undefined && override === authoritativeTif) get().drop(oid);
	},
	drop: (oid) => {
		const timer = get().timers[oid];
		if (timer) clearTimeout(timer);
		set((state) => {
			if (!(oid in state.overrides || oid in state.pending || oid in state.errors || oid in state.timers)) return state;
			const overrides = { ...state.overrides };
			const pending = { ...state.pending };
			const errors = { ...state.errors };
			const timers = { ...state.timers };
			delete overrides[oid];
			delete pending[oid];
			delete errors[oid];
			delete timers[oid];
			return { overrides, pending, errors, timers };
		});
	},
}));

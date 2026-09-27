import { create } from "zustand";
import { PAPER_TRADE } from "@/config/paper";
import { playFillSound } from "@/lib/fill-sound";

/**
 * Top-right fill popups + chime. Producers (the preview fill engine / live userFills
 * stream) call `emitFillNotifications`; one chime per batch, one popup per fill, and
 * the stack never shows more than a few at once.
 */

export interface FillNotificationInput {
	side: "buy" | "sell";
	market: string;
	size: string;
	price?: string;
	/** "Limit" | "Market" | "TP" | "SL" | "Trigger" — omitted for live-stream fills. */
	kind?: string;
}

export interface FillNotification extends FillNotificationInput {
	id: string;
	preview: boolean;
	createdAt: number;
}

interface FillNotificationsStore {
	items: FillNotification[];
	actions: {
		pushFills: (fills: readonly FillNotificationInput[]) => void;
		dismiss: (id: string) => void;
	};
}

const MAX_VISIBLE = 4;
let notificationCounter = 0;

export const useFillNotificationsStore = create<FillNotificationsStore>()((set) => ({
	items: [],
	actions: {
		pushFills: (fills) => {
			if (fills.length === 0) return;
			// One chime per batch (a single tick can fill several orders).
			playFillSound(fills[0].side);
			const preview = PAPER_TRADE;
			const now = Date.now();
			const items: FillNotification[] = fills.map((fill) => ({
				...fill,
				id: `fill-${now}-${++notificationCounter}`,
				preview,
				createdAt: now,
			}));
			set((state) => ({ items: [...items, ...state.items].slice(0, MAX_VISIBLE) }));
		},
		dismiss: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
	},
}));

/** Non-React entry point for fill producers (the paper store, the live stream hook). */
export function emitFillNotifications(fills: readonly FillNotificationInput[]): void {
	useFillNotificationsStore.getState().actions.pushFills(fills);
}

export function useFillNotifications(): FillNotification[] {
	return useFillNotificationsStore((state) => state.items);
}

export function useFillNotificationActions(): FillNotificationsStore["actions"] {
	return useFillNotificationsStore((state) => state.actions);
}

if (import.meta.env.DEV) {
	// Debug affordance for browser test scripts (dev builds only).
	(globalThis as { __hlNotif?: typeof useFillNotificationsStore }).__hlNotif = useFillNotificationsStore;
}

import { z } from "zod";
import { create } from "zustand";
import { createJSONStorage, persist, subscribeWithSelector } from "zustand/middleware";
import { STORAGE_KEYS } from "@/config/app";
import { type LimitTif, ORDER_TYPES, type OrderType } from "@/config/trade";
import { formatSizeForOrder } from "@/domain/trade/orders";
import { createValidatedStorage } from "@/lib/storage/validated-storage";
import { isScaleOrderType, isTriggerOrderType } from "@/lib/trade/order-types";
import { calculateDefaultTpSl } from "@/lib/trade/tpsl";
import type { Side, SizeMode } from "@/lib/trade/types";
import { getDefaultLimitSizeUsd } from "@/stores/use-global-settings-store";

interface PersistedState {
	side: Side;
	orderType: OrderType;
	sizeMode: SizeMode;
	/**
	 * Live Reduce Only flag — mirrors `reduceOnlyBySide[side]` (sticky: survives
	 * resetForm and reloads). Triggers override it to true while active.
	 */
	reduceOnly: boolean;
	/**
	 * Reduce Only memory per side: toggling it on long must not change the short's
	 * memory (and vice versa). Side switches load the selected side's slot.
	 */
	reduceOnlyBySide: Record<Side, boolean>;
	/**
	 * Last size used — remembered across reloads on every order form. The default
	 * limit size only fills it when it has never been used (empty).
	 */
	size: string;
}

interface FormState {
	limitPrice: string;
	triggerPrice: string;
	scaleStart: string;
	scaleEnd: string;
	scaleLevels: number;
	/** Interactive distribution curves (null = linear prices / uniform sizes; transient like the other scale fields). */
	scalePriceDist: number[] | null;
	scaleAmountDist: number[] | null;
	/** The scale form's ladder preview is on (transient — cleared on submit like the scale fields). */
	scalePreview: boolean;
	/** Which scale field the next chart click writes (alternates Start ↔ End while previewing). */
	scaleChartPickTarget: "start" | "end";
	twapMinutes: number;
	twapRandomize: boolean;
	tpSlEnabled: boolean;
	tpPrice: string;
	slPrice: string;
	tif: LimitTif;
}

interface OrderEntryState extends PersistedState, FormState {}

interface OrderEntryActions {
	setSide: (side: Side) => void;
	setOrderType: (orderType: OrderType, opts?: { price?: number; szDecimals?: number }) => void;
	setSizeMode: (mode: SizeMode) => void;
	toggleSizeMode: () => void;

	setSize: (size: string) => void;
	setLimitPrice: (price: string) => void;
	setTriggerPrice: (price: string) => void;
	setScaleStart: (price: string) => void;
	setScaleEnd: (price: string) => void;
	setScaleLevels: (levels: number) => void;
	setScalePriceDist: (dist: number[] | null) => void;
	setScaleAmountDist: (dist: number[] | null) => void;
	setScalePreview: (preview: boolean) => void;
	setScaleChartPickTarget: (target: "start" | "end") => void;
	setTwapMinutes: (minutes: number) => void;
	setTwapRandomize: (randomize: boolean) => void;
	setReduceOnly: (reduceOnly: boolean) => void;
	/**
	 * Toggle the TP/SL rows. Turning on seeds fresh ±2% defaults off `seed.base`
	 * (side-aware; fields stay empty when no usable base) so the chart can draw its
	 * preview lines; turning off clears the fields so the next enable re-seeds.
	 */
	setTpSlEnabled: (enabled: boolean, seed?: { base?: number; priceDecimals?: number }) => void;
	setTpPrice: (price: string) => void;
	setSlPrice: (price: string) => void;
	setTif: (tif: LimitTif) => void;

	resetForm: () => void;
	resetPrices: () => void;
}

interface OrderEntryStore extends OrderEntryState {
	actions: OrderEntryActions;
}

/**
 * Scale prices drive their own preview: a lone start/end previews its single line,
 * both ends draw the full ladder — so filling fields (or chart-picking a price)
 * always shows the result without pressing the Preview button first. Manual
 * toggles are respected; the next price edit re-shows.
 */
function withAutoScalePreview(state: OrderEntryState, patch: Partial<OrderEntryState>): Partial<OrderEntryState> {
	if (patch.scalePreview !== undefined) return patch;
	const next = { ...state, ...patch } as OrderEntryState;
	if (next.orderType !== "scale" || next.scalePreview) return patch;
	const start = Number(next.scaleStart);
	const end = Number(next.scaleEnd);
	const hasPrice = (Number.isFinite(start) && start > 0) || (Number.isFinite(end) && end > 0);
	if (!hasPrice) return patch;
	return { ...patch, scalePreview: true };
}

const DEFAULT_PERSISTED: PersistedState = {
	side: "buy",
	size: "",
	orderType: "market",
	sizeMode: "base",
	reduceOnly: false,
	reduceOnlyBySide: { buy: false, sell: false },
};

const DEFAULT_FORM: FormState = {
	limitPrice: "",
	triggerPrice: "",
	scaleStart: "",
	scaleEnd: "",
	scaleLevels: 4,
	scalePriceDist: null,
	scaleAmountDist: null,
	scalePreview: false,
	scaleChartPickTarget: "start",
	twapMinutes: 30,
	twapRandomize: true,
	tpSlEnabled: false,
	tpPrice: "",
	slPrice: "",
	tif: "Alo",
};

const orderEntrySchema = z.object({
	state: z.object({
		side: z.enum(["buy", "sell"]).optional(),
		orderType: z.enum(ORDER_TYPES).optional(),
		sizeMode: z.enum(["base", "quote"]).optional(),
		reduceOnly: z.boolean().optional(),
		reduceOnlyBySide: z.object({ buy: z.boolean(), sell: z.boolean() }).optional(),
		size: z.string().optional(),
	}),
});

const validatedStorage = createValidatedStorage(orderEntrySchema, "order entry");

export const useOrderEntryStore = create<OrderEntryStore>()(
	subscribeWithSelector(
		persist(
			(set) => ({
				...DEFAULT_PERSISTED,
				...DEFAULT_FORM,

				actions: {
					setSide: (side) =>
						set((state) => ({
							side,
							// Each side remembers its own Reduce Only state — switching loads the
							// selected side's slot (trigger types are always reduce-only).
							reduceOnly: isTriggerOrderType(state.orderType) ? true : state.reduceOnlyBySide[side],
						})),

					setOrderType: (orderType, opts) => {
						const isTrigger = isTriggerOrderType(orderType);
						const isScale = isScaleOrderType(orderType);
						set((state) => {
							const wasTrigger = isTriggerOrderType(state.orderType);
							const needsTifReset = isScale && state.tif === "Ioc";
							function nextReduceOnly() {
								if (isTrigger) return true;
								if (wasTrigger) return false;
								return state.reduceOnly;
							}
							const patch: Partial<OrderEntryState> = {
								orderType,
								reduceOnly: nextReduceOnly(),
								tpSlEnabled: isTrigger ? false : state.tpSlEnabled,
								tif: needsTifReset ? "Gtc" : state.tif,
							};
							// Default limit size (Settings, $USD): fills an EMPTY size when landing
							// on the limit tab — never clobbers a typed/sticky size. Quote mode
							// stores the USD amount directly; base mode converts at the reference
							// price (typed limit price, else the mark) and skips when that would
							// round to zero at the market's size precision.
							if (orderType === "limit" && state.size.trim() === "") {
								const usd = getDefaultLimitSizeUsd();
								if (Number.isFinite(usd) && usd > 0) {
									if (state.sizeMode === "quote") {
										// Quote mode stores the USD amount — no price needed.
										patch.size = String(usd);
									} else if (
										opts?.price !== undefined &&
										Number.isFinite(opts.price) &&
										opts.price > 0 &&
										opts.szDecimals !== undefined &&
										opts.szDecimals >= 0
									) {
										const base = formatSizeForOrder(usd / opts.price, opts.szDecimals);
										if (Number(base) > 0) patch.size = base;
									}
								}
							}
							return withAutoScalePreview(state, patch);
						});
					},

					setSizeMode: (sizeMode) => set({ sizeMode }),

					toggleSizeMode: () =>
						set((state) => ({
							sizeMode: state.sizeMode === "base" ? "quote" : "base",
						})),

					setSize: (size) => set({ size }),
					setLimitPrice: (limitPrice) => set({ limitPrice }),
					setTriggerPrice: (triggerPrice) => set({ triggerPrice }),
					setScaleStart: (scaleStart) => set((state) => withAutoScalePreview(state, { scaleStart })),
					setScaleEnd: (scaleEnd) => set((state) => withAutoScalePreview(state, { scaleEnd })),
					setScaleLevels: (scaleLevels) => set({ scaleLevels }), // count edits never resurrect a hidden preview
					// Distribution edits never resurrect a hidden preview either (same rule as levels).
					setScalePriceDist: (scalePriceDist) => set({ scalePriceDist }),
					setScaleAmountDist: (scaleAmountDist) => set({ scaleAmountDist }),
					setScalePreview: (scalePreview) => set({ scalePreview }),
					setScaleChartPickTarget: (scaleChartPickTarget) => set({ scaleChartPickTarget }),
					setTwapMinutes: (twapMinutes) => set({ twapMinutes }),
					setTwapRandomize: (twapRandomize) => set({ twapRandomize }),
					setReduceOnly: (reduceOnly) =>
						set((state) => ({
							reduceOnly,
							// Remembered per side: toggling on long must not change short's memory.
							reduceOnlyBySide: { ...state.reduceOnlyBySide, [state.side]: reduceOnly },
						})),
					setTpSlEnabled: (enabled, seed) =>
						set((state) => {
							if (!enabled) {
								// Clearing on disable keeps every enable deterministic: fresh ±2%.
								return { tpSlEnabled: false, tpPrice: "", slPrice: "" };
							}
							const base = seed?.base;
							const defaults =
								base !== undefined && base > 0
									? calculateDefaultTpSl(base, state.side, seed?.priceDecimals ?? 2)
									: null;
							if (!defaults) return { tpSlEnabled: true };
							return { tpSlEnabled: true, tpPrice: defaults.tp, slPrice: defaults.sl };
						}),
					setTpPrice: (tpPrice) => set({ tpPrice }),
					setSlPrice: (slPrice) => set({ slPrice }),
					setTif: (tif) => set({ tif }),

					// Clears transient inputs after a submission — the size lives in the
					// persisted slice now (remembered across reloads), so it is never touched
					// here; prices/TP-SL/scale still clear.
					resetForm: () => set({ ...DEFAULT_FORM }),

					resetPrices: () =>
						set({
							limitPrice: "",
							triggerPrice: "",
							scaleStart: "",
							scaleEnd: "",
							tpPrice: "",
							slPrice: "",
						}),
				},
			}),
			{
				name: STORAGE_KEYS.ORDER_ENTRY,
				version: 2,
				storage: createJSONStorage(() => validatedStorage),
				partialize: (state) => ({
					side: state.side,
					orderType: state.orderType,
					sizeMode: state.sizeMode,
					reduceOnly: state.reduceOnly,
					reduceOnlyBySide: state.reduceOnlyBySide,
					size: state.size,
				}),
				merge: (persisted, current) => {
					const p = persisted as Partial<PersistedState>;
					const side = p.side ?? DEFAULT_PERSISTED.side;
					const orderType = p.orderType ?? DEFAULT_PERSISTED.orderType;
					// Migrate pre-split saves (a single reduceOnly) into both slots, then keep
					// the live value aligned with the selected side — triggers are always
					// reduce-only regardless of the memory.
					const reduceOnlyBySide = p.reduceOnlyBySide ?? {
						buy: p.reduceOnly ?? DEFAULT_PERSISTED.reduceOnly,
						sell: p.reduceOnly ?? DEFAULT_PERSISTED.reduceOnly,
					};
					return {
						...current,
						...DEFAULT_PERSISTED,
						...DEFAULT_FORM,
						...p,
						side,
						orderType,
						reduceOnlyBySide,
						reduceOnly: isTriggerOrderType(orderType) ? true : reduceOnlyBySide[side],
					};
				},
			},
		),
	),
);

if (import.meta.env.DEV) {
	// Debug affordance for browser test scripts (dev builds only).
	(globalThis as { __hlOrderEntry?: typeof useOrderEntryStore }).__hlOrderEntry = useOrderEntryStore;
}

export function useOrderSide() {
	return useOrderEntryStore((s) => s.side);
}
export function useOrderType() {
	return useOrderEntryStore((s) => s.orderType);
}
export function useSizeMode() {
	return useOrderEntryStore((s) => s.sizeMode);
}
export function useReduceOnly() {
	return useOrderEntryStore((s) => s.reduceOnly);
}

export function useOrderSize() {
	return useOrderEntryStore((s) => s.size);
}
export function useLimitPrice() {
	return useOrderEntryStore((s) => s.limitPrice);
}
export function useTriggerPrice() {
	return useOrderEntryStore((s) => s.triggerPrice);
}

export function useScaleStart() {
	return useOrderEntryStore((s) => s.scaleStart);
}
export function useScaleEnd() {
	return useOrderEntryStore((s) => s.scaleEnd);
}
export function useScaleLevels() {
	return useOrderEntryStore((s) => s.scaleLevels);
}
export function useScaleChartPickTarget(): "start" | "end" {
	return useOrderEntryStore((s) => s.scaleChartPickTarget);
}

export function useScalePriceDist(): number[] | null {
	return useOrderEntryStore((s) => s.scalePriceDist);
}
export function useScaleAmountDist(): number[] | null {
	return useOrderEntryStore((s) => s.scaleAmountDist);
}
export function useScalePreview() {
	return useOrderEntryStore((s) => s.scalePreview);
}

export function useTwapMinutes() {
	return useOrderEntryStore((s) => s.twapMinutes);
}
export function useTwapRandomize() {
	return useOrderEntryStore((s) => s.twapRandomize);
}

export function useTpSlEnabled() {
	return useOrderEntryStore((s) => s.tpSlEnabled);
}
export function useTpPrice() {
	return useOrderEntryStore((s) => s.tpPrice);
}
export function useSlPrice() {
	return useOrderEntryStore((s) => s.slPrice);
}

export function useTif() {
	return useOrderEntryStore((s) => s.tif);
}

export function useOrderEntryActions() {
	return useOrderEntryStore((s) => s.actions);
}

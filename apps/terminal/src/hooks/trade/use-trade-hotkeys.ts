import { useEffect, useMemo, useRef } from "react";
import { HL_ALL_DEXS } from "@/config/app";
import { CHART_ACTION_IDS, HELP_HOTKEY, type HotkeyId } from "@/config/hotkeys";
import { PAPER_TRADE } from "@/config/paper";
import { formatPriceForOrder, formatSizeForOrder } from "@/domain/trade/orders";
import { useCancelOpenOrders } from "@/hooks/trade/use-cancel-open-orders";
import { useCloseAllPositions } from "@/hooks/trade/use-close-all-positions";
import { useIsMobile } from "@/hooks/use-mobile";
import { matchesHotkey, parseCombo, shouldHandleHotkey } from "@/lib/hotkeys/engine";
import { clearChartAction, markChartActionHeld, releaseChartAction } from "@/lib/hotkeys/hold-keys";
import { buildActiveHotkeys } from "@/lib/hotkeys/resolve";
import { useMarkets, useSubscription, useTradingSession, useUserPositions } from "@/lib/hyperliquid";
import type { OpenOrder } from "@/lib/trade/open-orders";
import { submitOrderForm } from "@/lib/trade/submit-order-form";
import { useChaseOrderStore } from "@/stores/use-chase-order-store";
import { useGlobalSettingsActions, useSizeButtonAmounts } from "@/stores/use-global-settings-store";
import {
	useHotkeySettingsActions,
	useHotkeySettingsStore,
	useHotkeysEnabled,
} from "@/stores/use-hotkey-settings-store";
import { useSelectedMarket } from "@/stores/use-market-store";
import { useOrderEntryActions, useOrderEntryStore } from "@/stores/use-order-entry-store";
import { usePaperOpenOrderRows } from "@/stores/use-paper-store";

/**
 * Global hotkey listener for the trade terminal — the documented defaults
 * (config/hotkeys.ts), mounted once per terminal page. Guarantees:
 *  - never fires while typing (inputs/selects/contenteditable) or during IME input;
 *  - never fires on key repeat or when another handler already claimed the event;
 *  - disabled entirely by the persisted "enabled" setting;
 *  - chart hold-keys (A/D/S/V/B/Z) are tracked here and *completed* by the chart's
 *    mouse-up handler (hold key → click a price);
 *  - held keys clear on window blur so alt-tab can't leave one stuck.
 *
 * Handlers read store state through `getState()`/refs — never stale closures — and
 * form submits go through `submitOrderForm`, which flushes React synchronously first.
 */
export function useTradeHotkeys(): void {
	const enabled = useHotkeysEnabled();
	const settings = useHotkeySettingsActions();
	const symbol = useSelectedMarket();
	const isMobile = useIsMobile();
	const { setMobileActiveTab } = useGlobalSettingsActions();
	const orderEntry = useOrderEntryActions();
	const cancelOpenOrders = useCancelOpenOrders();
	const closeAllPositions = useCloseAllPositions();
	const { address, isActive } = useTradingSession();
	const paperRows = usePaperOpenOrderRows();
	const { getPosition } = useUserPositions();
	const markets = useMarkets();
	const sizeButtonAmounts = useSizeButtonAmounts();

	// Resting orders across all markets (X/U/I/O/P), live stream or preview book.
	const { data: openOrdersEvent } = useSubscription(
		"openOrders",
		{ user: address ?? "0x0", dex: HL_ALL_DEXS },
		{ enabled: !PAPER_TRADE && isActive },
	);
	// Marks + book for the Ctrl(+Shift)+A/D keys.
	const { data: midsEvent } = useSubscription("allMids", { dex: HL_ALL_DEXS }, { enabled });
	const { data: bookEvent } = useSubscription("l2Book", { coin: symbol }, { enabled: enabled && symbol !== "" });

	// Refs keep dispatch fresh without churning the listener.
	const ordersRef = useRef<OpenOrder[]>([]);
	ordersRef.current = PAPER_TRADE ? paperRows : (openOrdersEvent?.orders ?? []);
	const markRef = useRef<number | undefined>(undefined);
	const rawMark = midsEvent?.mids?.[symbol];
	const parsedMark = rawMark !== undefined ? Number(rawMark) : Number.NaN;
	markRef.current = Number.isFinite(parsedMark) && parsedMark > 0 ? parsedMark : undefined;
	const bookRef = useRef<typeof bookEvent>(undefined);
	bookRef.current = bookEvent;
	const symbolRef = useRef(symbol);
	symbolRef.current = symbol;
	const isMobileRef = useRef(isMobile);
	isMobileRef.current = isMobile;
	const sizeAmountsRef = useRef(sizeButtonAmounts);
	sizeAmountsRef.current = sizeButtonAmounts;
	const getPositionRef = useRef(getPosition);
	getPositionRef.current = getPosition;

	const actions = useMemo(() => {
		function submitAs(
			side: "buy" | "sell",
			orderType: "limit" | "market",
			extra?: { priceText?: string; reduceOnly?: boolean; sizeText?: string },
		) {
			submitOrderForm(() => {
				const store = useOrderEntryStore.getState().actions;
				store.setSide(side);
				store.setOrderType(
					orderType,
					orderType === "limit"
						? {
								price: extra?.priceText !== undefined ? Number(extra.priceText) : undefined,
								szDecimals: markets.getSzDecimals(symbolRef.current),
							}
						: undefined,
				);
				if (extra?.priceText !== undefined) store.setLimitPrice(extra.priceText);
				if (extra?.reduceOnly !== undefined) store.setReduceOnly(extra.reduceOnly);
				if (extra?.sizeText !== undefined) {
					store.setSizeMode("base");
					store.setSize(extra.sizeText);
				}
			});
		}

		function submitAsLimit(side: "buy" | "sell", priceText?: string) {
			submitAs(side, "limit", priceText !== undefined ? { priceText } : undefined);
		}

		function bestBookPrice(side: "buy" | "sell"): string | null {
			const levels = bookRef.current?.levels;
			const book = side === "buy" ? levels?.[0] : levels?.[1];
			const best = Array.isArray(book) ? (book[0] as { px?: string } | undefined) : undefined;
			const px = Number(best?.px);
			return Number.isFinite(px) && px > 0 ? formatPriceForOrder(px) : null;
		}

		/** 25% of the way from top of book toward mid — the documented small offset. */
		function offsetBookPrice(side: "buy" | "sell"): string | null {
			const mark = markRef.current;
			if (mark === undefined) return null;
			const top = bestBookPrice(side);
			if (top === null) return null;
			const topNum = Number(top);
			const price = side === "buy" ? topNum + (mark - topNum) * 0.25 : topNum - (topNum - mark) * 0.25;
			return Number.isFinite(price) && price > 0 ? formatPriceForOrder(price) : null;
		}

		function cancelBy(filter: (order: OpenOrder) => boolean): void {
			cancelOpenOrders(ordersRef.current.filter(filter));
		}

		function onActiveMarket(order: OpenOrder): boolean {
			return order.coin === symbolRef.current;
		}

		function closeActivePosition(orderType: "limit" | "market") {
			const position = getPositionRef.current(symbolRef.current);
			if (!position) return;
			const szi = Number(position.szi);
			if (!Number.isFinite(szi) || szi === 0) return;
			const side = szi > 0 ? ("sell" as const) : ("buy" as const);
			const sizeText = formatSizeForOrder(Math.abs(szi), markets.getSzDecimals(position.coin));
			if (orderType === "limit") {
				const mark = markRef.current;
				if (mark === undefined) return;
				submitAs(side, "limit", { priceText: formatPriceForOrder(mark), reduceOnly: true, sizeText });
				return;
			}
			submitAs(side, "market", { reduceOnly: true, sizeText });
		}

		function applySizePreset(index: number) {
			const amount = sizeAmountsRef.current[index];
			if (amount === undefined) return;
			const store = useOrderEntryStore.getState().actions;
			store.setSizeMode("quote");
			store.setSize(String(amount));
		}

		const table: Record<HotkeyId, () => void> = {
			// Chart click-actions are completed by the chart's mouse-up handler.
			limitAtClick: () => {},
			buyAtClick: () => {},
			sellAtClick: () => {},
			slAtClick: () => {},
			tpAtClick: () => {},
			setPriceFromChart: () => {},

			placeBuy: () => submitAsLimit("buy"),
			placeSell: () => submitAsLimit("sell"),
			// Bindable-without-default-key actions (Settings → Hotkeys assigns keys):
			// market orders, position closes, flatten, and size presets (presets SET the
			// size from the configured quick-add amounts).
			marketBuy: () => submitAs("buy", "market"),
			marketSell: () => submitAs("sell", "market"),
			flattenPositions: () => {
				void closeAllPositions();
			},
			marketClosePosition: () => closeActivePosition("market"),
			limitClosePosition: () => closeActivePosition("limit"),
			chaseClosePosition: () => {
				const position = getPositionRef.current(symbolRef.current);
				if (!position) return;
				const szi = Number(position.szi);
				if (!Number.isFinite(szi) || szi === 0) return;
				const chase = useChaseOrderStore.getState();
				if (chase.entry?.mode === "close" && chase.entry.coin === position.coin) return;
				chase.actions.start({
					coin: position.coin,
					dex: position.coin.includes(":") ? position.coin.split(":")[0] : "",
					side: szi > 0 ? "sell" : "buy",
					sizeText: formatSizeForOrder(Math.abs(szi), markets.getSzDecimals(position.coin)),
					reduceOnly: true,
					tif: "Alo",
					mode: "close",
					placementPending: true,
					startedAt: Date.now(),
				});
			},
			sizePreset1: () => applySizePreset(0),
			sizePreset2: () => applySizePreset(1),
			sizePreset3: () => applySizePreset(2),
			sizePreset4: () => applySizePreset(3),
			sizePreset5: () => applySizePreset(4),

			cancelRecent: () => {
				const resting = ordersRef.current
					.filter((order) => onActiveMarket(order) && !order.isTrigger)
					.sort((a, b) => b.timestamp - a.timestamp);
				if (resting.length > 0) cancelOpenOrders([resting[0]]);
			},
			cancelBuys: () => cancelBy((order) => onActiveMarket(order) && order.side === "B"),
			cancelSells: () => cancelBy((order) => onActiveMarket(order) && order.side === "A"),
			cancelMarketOrders: () => cancelBy(onActiveMarket),
			cancelAllOrders: () => cancelBy(() => true),

			topBookBuy: () => {
				const price = bestBookPrice("buy");
				if (price !== null) submitAsLimit("buy", price);
			},
			topBookSell: () => {
				const price = bestBookPrice("sell");
				if (price !== null) submitAsLimit("sell", price);
			},
			midBookBuy: () => {
				const price = offsetBookPrice("buy");
				if (price !== null) submitAsLimit("buy", price);
			},
			midBookSell: () => {
				const price = offsetBookPrice("sell");
				if (price !== null) submitAsLimit("sell", price);
			},

			togglePostOnly: () => {
				const current = useOrderEntryStore.getState().tif;
				orderEntry.setTif(current === "Alo" ? "Gtc" : "Alo");
			},
			toggleReduce: () => {
				const current = useOrderEntryStore.getState().reduceOnly;
				orderEntry.setReduceOnly(!current);
			},
			toggleOrderOverlay: () => {
				if (isMobileRef.current) {
					setMobileActiveTab("trade");
					return;
				}
				const form = document.querySelector<HTMLFormElement>("form[data-order-form]");
				form?.querySelector("input")?.focus();
			},
		};

		return table;
	}, [cancelOpenOrders, closeAllPositions, orderEntry, setMobileActiveTab, markets]);

	const actionsRef = useRef(actions);
	actionsRef.current = actions;
	const settingsRef = useRef(settings);
	settingsRef.current = settings;

	useEffect(() => {
		if (!enabled) return;

		function handleKeyDown(event: KeyboardEvent) {
			if (!shouldHandleHotkey(event, event.target)) return;

			const settings = useHotkeySettingsStore.getState();
			// The settings page is capturing a keystroke for a rebind - stay out of its way.
			if (settings.capturingId) return;

			// Our own addition: "?" toggles the shortcuts help overlay.
			if (matchesHotkey(event, HELP_HOTKEY)) {
				event.preventDefault();
				settingsRef.current.toggleHelpOpen();
				return;
			}

			const definition = buildActiveHotkeys(settings.overrides).find(
				(hotkey) => hotkey.combo !== null && matchesHotkey(event, hotkey.combo),
			);
			if (!definition) return;

			// Chart click-actions: remember which ACTION is held (rebind-proof); the
			// chart completes it when the user clicks a price.
			if ((CHART_ACTION_IDS as readonly string[]).includes(definition.id)) {
				markChartActionHeld(definition.id, parseCombo(definition.combo ?? "").key);
			}

			event.preventDefault();
			actionsRef.current[definition.id as HotkeyId]();
		}

		function handleKeyUp(event: KeyboardEvent) {
			releaseChartAction(event.key.toLowerCase());
		}

		function handleBlur() {
			clearChartAction();
		}

		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("keyup", handleKeyUp);
		window.addEventListener("blur", handleBlur);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("keyup", handleKeyUp);
			window.removeEventListener("blur", handleBlur);
			clearChartAction();
		};
	}, [enabled]);
}

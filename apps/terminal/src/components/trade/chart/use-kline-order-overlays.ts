import Big from "big.js";
import { type Chart, DomPosition } from "klinecharts";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { HL_ALL_DEXS } from "@/config/app";
import { PAPER_TRADE } from "@/config/paper";
import {
	type ChartLabelContext,
	chartOrderFromOpenOrder,
	type LineOverlayResolution,
} from "@/domain/trade/order/chart-labels";
import { buildOrderSegments } from "@/domain/trade/order/chart-risk";
import { orderMode } from "@/domain/trade/order/time-in-force";
import { useChartOrderMoves } from "@/hooks/trade/use-chart-order-moves";
import { useOrderLineActions } from "@/hooks/trade/use-order-line-actions";
import { canSwitchOrderTif, tifLabel, useReplaceOrderTif } from "@/hooks/trade/use-replace-order-tif";
import { useIsMobile } from "@/hooks/use-mobile";
import type { LineOverlayExtendData } from "@/lib/chart/create-line-overlay";
import { TRANSPARENT_OVERLAY_STYLES } from "@/lib/chart/kline-styles";
import { ORDER_LINE_NAME } from "@/lib/chart/order-line-overlay";
import { failedMoveSegments, pendingMoveSegments } from "@/lib/chart/order-move-label";
import { CANDLE_PANE_ID } from "@/lib/chart/price-axis";
import { useSubscription, useTradingSession, useUserPositions } from "@/lib/hyperliquid";
import type { OpenOrder } from "@/lib/trade/open-orders";
import { useOrderMoveStore } from "@/stores/use-order-move-store";
import { usePaperOpenOrderRows } from "@/stores/use-paper-store";
import { useTifOverrideStore } from "@/stores/use-tif-override-store";
import type { TifMenuAnchor } from "./order-tif-menu";
import { getShortBuilderSymbol } from "./use-kline-position-overlays";

interface Params {
	chartRef: RefObject<Chart | null>;
	/** Re-run signal: bumps when klinecharts rebuilds its instance (interval/symbol switch). */
	chartEpoch: number;
	symbol: string;
	dex?: string;
}

export function useKlineOrderOverlays({ chartRef, chartEpoch, symbol, dex }: Params) {
	const isMobile = useIsMobile();
	const { address, isActive } = useTradingSession();
	const paperRows = usePaperOpenOrderRows();
	const { getPosition } = useUserPositions();
	// Bumped after every drag so overlays snap back to authoritative data when a reprice fails.
	const [repriceNonce, setRepriceNonce] = useState(0);
	// Order type menu: the cell is canvas-drawn, the menu is a DOM popup.

	// Bumped after a type change so the canvas labels re-sync immediately: the
	// exchange echoes the new tif a moment later, and until it does the label would
	// still read the old type.
	const [tifNonce, setTifNonce] = useState(0);
	const { replaceOrderTif, effectiveTif } = useReplaceOrderTif(() => {
		setTifNonce((value) => value + 1);
	});

	const { data: openOrdersEvent } = useSubscription(
		"openOrders",
		{ user: address ?? "0x0", dex: HL_ALL_DEXS },
		{ enabled: !PAPER_TRADE && isActive },
	);
	// Live marks drive the labels' "if this hits" and cumulative PnL numbers.
	const { data: midsEvent } = useSubscription("allMids", { dex: HL_ALL_DEXS }, { enabled: true });

	const rawOrders = useMemo(
		() => (PAPER_TRADE ? paperRows : (openOrdersEvent?.orders ?? [])),
		[paperRows, openOrdersEvent],
	);
	const allOrders = useChartOrderMoves(rawOrders);
	const moves = useOrderMoveStore((state) => state.moves);
	const [tifMenu, setTifMenu] = useState<TifMenuAnchor | null>(null);
	// Settle optimistic type labels: once the exchange's open-orders data agrees with
	// what we set, the override is no longer needed.
	const clearIfAgrees = useTifOverrideStore((state) => state.clearIfAgrees);
	useEffect(() => {
		for (const order of rawOrders) clearIfAgrees(order.oid, orderMode(order));
	}, [rawOrders, clearIfAgrees]);

	const symbolOrders = useMemo(() => allOrders.filter((order) => order.coin === symbol), [allOrders, symbol]);
	const chartOrders = useMemo(() => symbolOrders.map(chartOrderFromOpenOrder), [symbolOrders]);

	// Labels read this ref at draw time, so numbers stay live without rebuilding overlays.
	const ctxRef = useRef<ChartLabelContext>({ position: null, orders: [], mark: undefined });
	const position = getPosition(symbol, dex) ?? getPosition(getShortBuilderSymbol(symbol), dex);
	const rawMark = midsEvent?.mids?.[symbol];
	const mark = rawMark !== undefined ? Number(rawMark) : Number.NaN;
	ctxRef.current = {
		position: position
			? {
					coin: position.coin,
					dex: position.dex ?? undefined,
					szi: Number(position.szi),
					entryPx: Number(position.entryPx),
				}
			: null,
		orders: chartOrders,
		mark: Number.isFinite(mark) && mark > 0 ? mark : undefined,
	};

	const { repriceOrder, cancelOrder, isCancelling, pendingCancels } = useOrderLineActions();

	const handleReprice = useCallback(
		(order: OpenOrder, rawValue: number) => {
			// Snap overlays back to authoritative data while the reprice lands (and if it fails).
			setRepriceNonce((n) => n + 1);
			void repriceOrder(order, rawValue);
		},
		[repriceOrder],
	);

	// Chart trading: the ✕ box on an order label cancels it — locally in preview mode,
	// through the exchange cancel method in live mode (shared with the hotkeys).
	const handleCancel = cancelOrder;
	// Bump when a cancel is in flight/finished so the overlay labels re-render.
	const pendingKey = [...pendingCancels].join(",");

	// repriceNonce intentionally forces a resync after drags that leave order data unchanged.
	// biome-ignore lint/correctness/useExhaustiveDependencies: repriceNonce must re-run the overlay sync
	useEffect(() => {
		const chart = chartRef.current;
		if (!chart || !symbol) return;

		chart.removeOverlay({ name: ORDER_LINE_NAME });

		for (const order of symbolOrders) {
			const rawPrice = order.isTrigger ? order.triggerPx : order.limitPx;
			const price = Big(rawPrice).toNumber();
			if (!Number.isFinite(price)) continue;

			const extendData: LineOverlayExtendData = {
				// Cancel in flight: swap the ✕ for an ellipsis so the press reads
				// instantly while the exchange round-trip is still running.
				getSegments: () => {
					const resolution = buildOrderSegments(chartOrderFromOpenOrder(order), ctxRef.current);
					const state = useTifOverrideStore.getState();
					const suffix = state.pending[order.oid] ? "…" : state.errors[order.oid] ? " !" : "";
					// Leftmost cell selects limit TIF or TP/SL trigger-market execution.
					const withTif: LineOverlayResolution = canSwitchOrderTif(order)
						? {
								...resolution,
								segments: [
									{
										text: tifLabel(effectiveTif(order), isMobile) + suffix,
										tone: resolution.segments[0].tone,
										key: "tif",
									},
									...resolution.segments,
								],
							}
						: resolution;
					const move = Object.values(useOrderMoveStore.getState().moves).find((move) => move.order.oid === order.oid);
					if (move?.error) return { ...resolution, segments: failedMoveSegments(resolution.segments[0].tone) };
					const moving = move?.pending;
					if (moving) withTif.segments = pendingMoveSegments(resolution.segments[0].tone, move.kind);
					if (!isCancelling(order.oid) && !moving) return withTif;
					return {
						...withTif,
						segments: withTif.segments.map((segment: (typeof withTif.segments)[number]) =>
							segment.key === "cancel" ? { ...segment, text: "…" } : segment,
						),
					};
				},
				onDragEnd: (next) => {
					if (!useOrderMoveStore.getState().isMoving(order.oid)) handleReprice(order, next);
				},
				onPressMoving: () => useOrderMoveStore.getState().isMoving(order.oid),
				onClickBox: (key, event) => {
					if (useOrderMoveStore.getState().isMoving(order.oid)) return;
					if (key === "cancel") handleCancel(order);
					if (key === "tif" && !useTifOverrideStore.getState().pending[order.oid]) {
						// Overlay x/y are pane-local; the body portal needs viewport coordinates.
						const rect = chart.getDom(CANDLE_PANE_ID, DomPosition.Main)?.getBoundingClientRect();
						const x =
							typeof event.pageX === "number" ? event.pageX - window.scrollX : (rect?.left ?? 0) + (event.x ?? 80);
						const y =
							typeof event.pageY === "number" ? event.pageY - window.scrollY : (rect?.top ?? 0) + (event.y ?? 120);
						setTifMenu({ order, x, y });
					}
				},
			};

			chart.createOverlay({
				name: ORDER_LINE_NAME,
				points: [{ value: price }],
				modeSensitivity: 0,
				styles: TRANSPARENT_OVERLAY_STYLES,
				extendData,
			});
		}
	}, [
		chartRef,
		chartEpoch,
		symbol,
		symbolOrders,
		handleReprice,
		handleCancel,
		pendingKey,
		repriceNonce,
		tifNonce,
		effectiveTif,
		moves,
		isMobile,
	]);

	return { tifMenu, openTifMenu: setTifMenu, applyTif: replaceOrderTif };
}

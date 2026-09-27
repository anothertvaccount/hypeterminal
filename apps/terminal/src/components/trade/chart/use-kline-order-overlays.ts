import Big from "big.js";
import type { Chart } from "klinecharts";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { HL_ALL_DEXS } from "@/config/app";
import { PAPER_TRADE } from "@/config/paper";
import { type ChartLabelContext, chartOrderFromOpenOrder } from "@/domain/trade/order/chart-labels";
import { buildOrderSegments } from "@/domain/trade/order/chart-risk";
import { useOrderLineActions } from "@/hooks/trade/use-order-line-actions";
import type { LineOverlayExtendData } from "@/lib/chart/create-line-overlay";
import { TRANSPARENT_OVERLAY_STYLES } from "@/lib/chart/kline-styles";
import { ORDER_LINE_NAME } from "@/lib/chart/order-line-overlay";
import { useSubscription, useTradingSession, useUserPositions } from "@/lib/hyperliquid";
import type { OpenOrder } from "@/lib/trade/open-orders";
import { usePaperOpenOrderRows } from "@/stores/use-paper-store";
import { getShortBuilderSymbol } from "./use-kline-position-overlays";

interface Params {
	chartRef: RefObject<Chart | null>;
	/** Re-run signal: bumps when klinecharts rebuilds its instance (interval/symbol switch). */
	chartEpoch: number;
	symbol: string;
	dex?: string;
}

export function useKlineOrderOverlays({ chartRef, chartEpoch, symbol, dex }: Params) {
	const { address, isActive } = useTradingSession();
	const paperRows = usePaperOpenOrderRows();
	const { getPosition } = useUserPositions();
	// Bumped after every drag so overlays snap back to authoritative data when a reprice fails.
	const [repriceNonce, setRepriceNonce] = useState(0);

	const { data: openOrdersEvent } = useSubscription(
		"openOrders",
		{ user: address ?? "0x0", dex: HL_ALL_DEXS },
		{ enabled: !PAPER_TRADE && isActive },
	);
	// Live marks drive the labels' "if this hits" and cumulative PnL numbers.
	const { data: midsEvent } = useSubscription("allMids", { dex: HL_ALL_DEXS }, { enabled: true });

	const allOrders = useMemo(
		() => (PAPER_TRADE ? paperRows : (openOrdersEvent?.orders ?? [])),
		[paperRows, openOrdersEvent],
	);
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
					if (!isCancelling(order.oid)) return resolution;
					return {
						...resolution,
						segments: resolution.segments.map((segment) =>
							segment.key === "cancel" ? { ...segment, text: "…" } : segment,
						),
					};
				},
				onDragEnd: (next) => handleReprice(order, next),
				onClickBox: (key) => {
					if (key === "cancel") handleCancel(order);
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
	}, [chartRef, chartEpoch, symbol, symbolOrders, handleReprice, handleCancel, pendingKey, repriceNonce]);
}

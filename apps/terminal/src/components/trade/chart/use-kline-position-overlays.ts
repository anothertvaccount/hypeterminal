import type { Chart, OverlayEvent } from "klinecharts";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { HL_ALL_DEXS } from "@/config/app";
import { buildPositionSegments, buildTpSlGhostSegments } from "@/domain/trade/order/chart-labels";
import { usePlaceTpSl } from "@/hooks/trade/use-place-tpsl";
import type { LineOverlayExtendData } from "@/lib/chart/create-line-overlay";
import { TRANSPARENT_OVERLAY_STYLES } from "@/lib/chart/kline-styles";
import { LIQUIDATION_LINE_NAME } from "@/lib/chart/liquidation-line-overlay";
import { POSITION_LINE_NAME } from "@/lib/chart/position-line-overlay";
import { useSubscription, useUserPositions } from "@/lib/hyperliquid";

interface Params {
	chartRef: RefObject<Chart | null>;
	/** Re-run signal: bumps when klinecharts rebuilds its instance (interval/symbol switch). */
	chartEpoch: number;
	symbol: string;
	dex?: string;
}

export function getShortBuilderSymbol(symbol: string): string {
	const separatorIndex = symbol.indexOf(":");
	if (separatorIndex === -1) return symbol;
	return symbol.slice(separatorIndex + 1);
}

export function useKlinePositionOverlays({ chartRef, chartEpoch, symbol, dex }: Params) {
	const { getPosition } = useUserPositions();

	// Live marks for the position label's uPnL.
	const { data: midsEvent } = useSubscription("allMids", { dex: HL_ALL_DEXS }, { enabled: true });

	const position = getPosition(symbol, dex) ?? getPosition(getShortBuilderSymbol(symbol), dex);
	const szi = position?.szi;
	const entryPx = position?.entryPx;
	const liquidationPx = position?.liquidationPx;

	const rawMark = midsEvent?.mids?.[symbol];
	const parsedMark = rawMark !== undefined ? Number(rawMark) : Number.NaN;
	const markRef = useRef<number | undefined>(undefined);
	markRef.current = Number.isFinite(parsedMark) && parsedMark > 0 ? parsedMark : undefined;

	// TP/SL buttons on the position label start a press-drag; the line follows the
	// pointer (visual feedback of the drop price) and snaps back to the entry on release.
	const dragModeRef = useRef<"tp" | "sl" | null>(null);
	const pressStartValueRef = useRef<number | null>(null);
	const [snapNonce, setSnapNonce] = useState(0);

	const placeTpSl = usePlaceTpSl();

	// The gesture handlers stay referentially stable (they read the placer and its
	// params through refs) so mids ticks never churn the overlay — only real position
	// changes do.
	const placeTpSlRef = useRef(placeTpSl);
	placeTpSlRef.current = placeTpSl;
	const tpSlParamsRef = useRef({ coin: symbol, dex });
	tpSlParamsRef.current = { coin: symbol, dex };

	const onPressStart = useCallback((key: string | undefined, event: OverlayEvent): boolean => {
		dragModeRef.current = key === "tp" || key === "sl" ? key : null;
		const startValue = event.overlay.points[0]?.value;
		pressStartValueRef.current = typeof startValue === "number" ? startValue : null;
		// The chart library ignores this return value; movement is gated in onPressMoving.
		return dragModeRef.current !== null;
	}, []);

	// Only the TP/SL buttons may move the line — presses elsewhere are cancelled outright
	// (the entry line can never be knocked out of place).
	const onPressMoving = useCallback(() => dragModeRef.current === null, []);

	const onPressEnd = useCallback((event: OverlayEvent) => {
		const mode = dragModeRef.current;
		dragModeRef.current = null;
		// Always resync: the line may have followed the pointer away from the entry.
		setSnapNonce((n) => n + 1);
		if (!mode) return;
		const value = event.overlay.points[0]?.value;
		const price = typeof value === "number" ? value : Number.NaN;
		if (!Number.isFinite(price) || price <= 0) return;
		// A plain click on the button (no drop-price change) places nothing — a TP/SL
		// silently created at the entry price would be invisible and instantly marketable.
		if (pressStartValueRef.current !== null && price === pressStartValueRef.current) return;
		pressStartValueRef.current = null;
		placeTpSlRef.current({ ...tpSlParamsRef.current, tpsl: mode, price });
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: snapNonce resyncs the line after a gesture
	useEffect(() => {
		const chart = chartRef.current;
		if (!chart || !symbol) return;

		chart.removeOverlay({ name: POSITION_LINE_NAME });
		chart.removeOverlay({ name: LIQUIDATION_LINE_NAME });

		if (szi == null || entryPx == null) return;

		const sziValue = Number(szi);
		if (!Number.isFinite(sziValue) || sziValue === 0) return;
		const entryValue = Number(entryPx);
		if (!Number.isFinite(entryValue) || entryValue <= 0) return;

		const extendData: LineOverlayExtendData = {
			getSegments: () => buildPositionSegments({ coin: symbol, szi: sziValue, entryPx: entryValue }, markRef.current),
			// During a TP/SL drag the entry row stays PINNED at the entry pixel (the
			// chart library moves only the overlay's point) and a floating ghost chip
			// with the projected $/% shows at the drop price.
			getResolution: ({ pointValue, y, yAxis }) => {
				const base = buildPositionSegments({ coin: symbol, szi: sziValue, entryPx: entryValue }, markRef.current);
				const mode = dragModeRef.current;
				if (mode === null || !yAxis) return base;
				if (typeof pointValue !== "number" || !Number.isFinite(pointValue)) return base;
				if (typeof y !== "number") return base;
				return {
					...base,
					lineY: yAxis.convertToPixel(entryValue),
					ghost: {
						y,
						anchor: mode,
						segments: buildTpSlGhostSegments({
							tpsl: mode,
							entryPx: entryValue,
							szi: sziValue,
							price: pointValue,
						}),
					},
				};
			},
			onPressStart,
			onPressMoving,
			onPressEnd,
		};

		chart.createOverlay({
			name: POSITION_LINE_NAME,
			points: [{ value: entryValue }],
			modeSensitivity: 0,
			styles: TRANSPARENT_OVERLAY_STYLES,
			extendData,
		});

		if (liquidationPx != null) {
			const liqPxBig = Number(liquidationPx);
			if (Number.isFinite(liqPxBig) && liqPxBig > 0) {
				chart.createOverlay({
					name: LIQUIDATION_LINE_NAME,
					points: [{ value: liqPxBig }],
					modeSensitivity: 0,
					styles: TRANSPARENT_OVERLAY_STYLES,
				});
			}
		}
	}, [chartRef, chartEpoch, symbol, szi, entryPx, liquidationPx, onPressStart, onPressMoving, onPressEnd, snapNonce]);
}

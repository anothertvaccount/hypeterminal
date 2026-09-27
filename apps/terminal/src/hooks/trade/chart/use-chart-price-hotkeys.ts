import { type RefObject, useEffect, useRef } from "react";
import { usePlaceTpSl } from "@/hooks/trade/use-place-tpsl";
import { isChartOverlayInteractionRecent } from "@/lib/chart/overlay-interaction";
import { resolveAxisPrice } from "@/lib/chart/price-axis";
import { getHeldChartAction } from "@/lib/hotkeys/hold-keys";
import { useMarkets, useUserPositions } from "@/lib/hyperliquid";
import {
	type ChartPriceActionId,
	runChartPriceAction,
	useChartHotkeysEnabled,
	useChartMark,
} from "@/lib/trade/chart-price-actions";

interface Params {
	containerRef: RefObject<HTMLDivElement | null>;
	/** Raw price at a container-relative y — chart-specific conversion (klinecharts pixel, TV fit). */
	priceAt: (yContainer: number) => number | null;
	symbol: string;
	dex?: string;
}

/** Maximum drift (px) between mouse-down and mouse-up that still counts as a click. */
const MAX_CLICK_DRIFT_PX = 4;

/**
 * Hold-key + click chart actions: hold A/D/S/V/B/Z, click a price on the
 * chart → buy / sell / side-auto limit / set price / place SL / place TP there.
 *
 * Guards: hotkeys disabled → nothing; click drifted >4px (it was a drag) → nothing;
 * the press started on a chart label (✕ / TP / SL — stamped by the overlay layer)
 * → nothing; price conversion failed → nothing. The action execution itself lives
 * in runChartPriceAction so the klinecharts canvas and the TradingView overlay
 * layer behave identically (and respect rebinds).
 */
export function useChartPriceHotkeys({ containerRef, priceAt, symbol, dex }: Params): void {
	const enabled = useChartHotkeysEnabled();
	const { getPosition } = useUserPositions();
	const placeTpSl = usePlaceTpSl();
	const markets = useMarkets();
	const mark = useChartMark(symbol);

	// Handlers read the latest values through refs so the listeners never go stale.
	const markRef = useRef<number | undefined>(undefined);
	markRef.current = mark;
	const placeTpSlRef = useRef(placeTpSl);
	placeTpSlRef.current = placeTpSl;
	const getPositionRef = useRef(getPosition);
	getPositionRef.current = getPosition;
	const priceAtRef = useRef(priceAt);
	priceAtRef.current = priceAt;
	const marketsRef = useRef(markets);
	marketsRef.current = markets;
	const paramsRef = useRef({ symbol, dex });
	paramsRef.current = { symbol, dex };

	useEffect(() => {
		if (!enabled) return;
		const container = containerRef.current;
		if (!container) return;

		let downPoint: { x: number; y: number } | null = null;

		function handleMouseDown(event: MouseEvent) {
			if (event.button !== 0) return;
			downPoint = { x: event.clientX, y: event.clientY };
		}

		function handleMouseUp(event: MouseEvent) {
			if (import.meta.env.DEV) {
				(globalThis as { __hlUpCount?: number }).__hlUpCount =
					((globalThis as { __hlUpCount?: number }).__hlUpCount ?? 0) + 1;
			}
			const start = downPoint;
			downPoint = null;
			if (!start) return;
			// Drifting >4px means the gesture was a chart drag, not a click.
			if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > MAX_CLICK_DRIFT_PX) return;
			// The press started on a chart label (✕ / TP / SL) — that press had its own job.
			if (isChartOverlayInteractionRecent()) return;

			// Action-based (not letter-based) so rebinding in settings keeps this working.
			const heldId = getHeldChartAction() as ChartPriceActionId | null;
			if (!heldId) return;

			const rect = container?.getBoundingClientRect();
			if (!rect) return;
			const y = event.clientY - rect.top;
			const rawPrice = priceAtRef.current(y);
			const priceText = resolveAxisPrice(rawPrice ?? Number.NaN);
			if (!priceText) return;

			runChartPriceAction(heldId, priceText, {
				symbol: paramsRef.current.symbol,
				dex: paramsRef.current.dex,
				mark: markRef.current,
				getPosition: getPositionRef.current,
				placeTpSl: placeTpSlRef.current,
				szDecimals: marketsRef.current.getSzDecimals(paramsRef.current.symbol),
			});
		}

		function handleMouseLeave() {
			downPoint = null;
		}

		container.addEventListener("mousedown", handleMouseDown);
		container.addEventListener("mouseup", handleMouseUp);
		container.addEventListener("mouseleave", handleMouseLeave);
		return () => {
			container.removeEventListener("mousedown", handleMouseDown);
			container.removeEventListener("mouseup", handleMouseUp);
			container.removeEventListener("mouseleave", handleMouseLeave);
			downPoint = null;
		};
	}, [enabled, containerRef]);
}

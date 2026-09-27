import { type RefObject, useEffect, useState } from "react";
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
import { type TvMeasurement, tvViewportYToPrice } from "./tv-calibration";
import type { TvCalibration } from "./use-tv-calibration";

interface Params {
	hostRef: RefObject<HTMLElement | null>;
	calibration: TvCalibration;
	symbol: string;
	dex?: string;
}

/** Maximum drift (px) between mouse-down and mouse-up that still counts as a click. */
const MAX_CLICK_DRIFT_PX = 4;

/**
 * Hold-key + click actions on the TradingView chart. The library's iframe swallows
 * pointer events, so a parent-level capture layer appears ONLY while a chart-action
 * key is held — clicks never interfere with TradingView's own pan/zoom/drawings
 * otherwise. Prices come from the same calibration fit; execution is the shared
 * runChartPriceAction (identical to the klinecharts canvas, rebinds included).
 */
export function TradingViewHoldClick({ hostRef, calibration, symbol, dex }: Params) {
	const enabled = useChartHotkeysEnabled();
	const { getPosition } = useUserPositions();
	const placeTpSl = usePlaceTpSl();
	const markets = useMarkets();
	const mark = useChartMark(symbol);
	const [active, setActive] = useState(false);
	const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

	useEffect(() => {
		const sync = () => {
			setActive(getHeldChartAction() !== null);
		};
		const keyup = () => {
			if (getHeldChartAction() === null) setActive(false);
		};
		window.addEventListener("keydown", sync);
		window.addEventListener("keyup", keyup);
		window.addEventListener("blur", keyup);
		return () => {
			window.removeEventListener("keydown", sync);
			window.removeEventListener("keyup", keyup);
			window.removeEventListener("blur", keyup);
		};
	}, []);

	// Size the capture box to the plot while active (measurement can appear late).
	useEffect(() => {
		if (!active) return;
		let raf = 0;
		const sync = () => {
			raf = requestAnimationFrame(sync);
			const m: TvMeasurement | null = calibration.get();
			const host = hostRef.current;
			if (!m || !host) {
				setBox(null);
				return;
			}
			const rect = host.getBoundingClientRect();
			const next = {
				left: m.plot.left - rect.left,
				top: m.plot.top - rect.top,
				width: m.plot.width,
				height: m.plot.height,
			};
			setBox((prev) =>
				prev &&
				prev.left === next.left &&
				prev.top === next.top &&
				prev.width === next.width &&
				prev.height === next.height
					? prev
					: next,
			);
		};
		sync();
		return () => cancelAnimationFrame(raf);
	}, [active, calibration, hostRef]);

	if (!enabled || !active || !box) return null;

	let down: { x: number; y: number } | null = null;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: transparent chart capture layer, only mounted while a chart-action key is held
		<div
			data-tv-hold=""
			role="presentation"
			className="absolute z-[25]"
			style={{ left: box.left, top: box.top, width: box.width, height: box.height, cursor: "crosshair" }}
			onMouseDown={(event) => {
				if (event.button !== 0) return;
				down = { x: event.clientX, y: event.clientY };
			}}
			onMouseUp={(event) => {
				const start = down;
				down = null;
				if (!start) return;
				if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > MAX_CLICK_DRIFT_PX) return;
				if (isChartOverlayInteractionRecent()) return;
				const heldId = getHeldChartAction() as ChartPriceActionId | null;
				if (!heldId) return;
				const m = calibration.get();
				if (!m) return;
				const priceText = resolveAxisPrice(tvViewportYToPrice(m, event.clientY));
				if (!priceText) return;
				runChartPriceAction(heldId, priceText, {
					symbol,
					dex,
					mark,
					getPosition,
					placeTpSl,
					szDecimals: markets.getSzDecimals(symbol),
				});
			}}
			onMouseLeave={() => {
				down = null;
			}}
		/>
	);
}

import { getMarketCapabilities } from "@hypeterminal/hl-react";
import type { Chart } from "klinecharts";
import { type RefObject, useEffect, useRef, useState } from "react";
import { HL_ALL_DEXS } from "@/config/app";
import { buildPreviewSegments, computeFormDrafts, draftReferencePrice } from "@/domain/trade/order/chart-preview";
import { formatPriceForOrder, formatSizeForOrder } from "@/domain/trade/orders";
import { useOrderEntryData } from "@/hooks/trade/use-order-entry-data";
import type { LineOverlayExtendData } from "@/lib/chart/create-line-overlay";
import { TRANSPARENT_OVERLAY_STYLES } from "@/lib/chart/kline-styles";
import { PREVIEW_LINE_NAME } from "@/lib/chart/preview-line-overlay";
import { useSelectedMarketInfo, useSubscription } from "@/lib/hyperliquid";
import { canUseTpSl } from "@/lib/trade/order-types";
import {
	useLimitPrice,
	useOrderEntryActions,
	useOrderSide,
	useOrderSize,
	useOrderType,
	useScaleAmountDist,
	useScaleEnd,
	useScaleLevels,
	useScalePreview,
	useScalePriceDist,
	useScaleStart,
	useSizeMode,
	useSlPrice,
	useTpPrice,
	useTpSlEnabled,
} from "@/stores/use-order-entry-store";
import { getShortBuilderSymbol } from "./use-kline-position-overlays";

interface Params {
	chartRef: RefObject<Chart | null>;
	/** Re-run signal: bumps when klinecharts rebuilds its instance (interval/symbol switch). */
	chartEpoch: number;
	symbol: string;
}

/**
 * Draws the form's drafts on the canvas: a PREVIEW line for the typed limit price
 * plus one each for the enabled TP and SL — all clearly marked "not in book until
 * submitted". They follow the form field by field (each edit re-syncs), are
 * draggable exactly like real order lines (a release writes the dragged price back
 * into the matching form field — never to the exchange), and vanish the moment the
 * field clears, TP/SL toggles off, or the chart leaves the form's market.
 */
export function useKlineFormPreviewOverlays({ chartRef, chartEpoch, symbol }: Params) {
	const side = useOrderSide();
	const orderType = useOrderType();
	const limitPriceInput = useLimitPrice();
	const tpSlEnabled = useTpSlEnabled();
	const tpPriceInput = useTpPrice();
	const slPriceInput = useSlPrice();
	const scaleStartInput = useScaleStart();
	const scaleEndInput = useScaleEnd();
	const scaleLevels = useScaleLevels();
	const scalePreview = useScalePreview();
	const { setLimitPrice, setTpPrice, setSlPrice, setScaleStart, setScaleEnd } = useOrderEntryActions();
	// Bumped when a middle ladder line is released: the point springs back to the
	// field-derived price (a scale is a range — only START/END map to fields).
	const [dragNonce, setDragNonce] = useState(0);
	const { data: market } = useSelectedMarketInfo();
	const sizeInput = useOrderSize();
	const sizeMode = useSizeMode();
	const scalePriceDist = useScalePriceDist();
	const scaleAmountDist = useScaleAmountDist();
	const { data: midsEvent } = useSubscription("allMids", { dex: HL_ALL_DEXS }, { enabled: true });
	const rawMark = midsEvent?.mids?.[symbol];
	const parsedMark = rawMark !== undefined ? Number(rawMark) : Number.NaN;
	const markPx = Number.isFinite(parsedMark) && parsedMark > 0 ? parsedMark : 0;
	const { sizeValue, szDecimals } = useOrderEntryData({ market, side, markPx, sizeMode, sizeInput });
	const refPrice = draftReferencePrice({
		orderType,
		limitPriceInput,
		scaleStartInput,
		scaleEndInput,
		mark: markPx,
	});
	// Numbers are read at DRAW time, so size/price edits relabel without rebuilding overlays.
	const previewDetailRef = useRef<{ size: number; refPrice?: number; szDecimals: number } | null>(null);
	previewDetailRef.current = { size: sizeValue, refPrice, szDecimals };
	const marketName = market?.name;

	// biome-ignore lint/correctness/useExhaustiveDependencies: dragNonce re-runs the sync so a springed-back middle ladder line redraws at its field-derived price
	useEffect(() => {
		const chart = chartRef.current;
		if (!chart || !symbol) return;
		chart.removeOverlay({ name: PREVIEW_LINE_NAME });
		if (!marketName || (marketName !== symbol && getShortBuilderSymbol(marketName) !== symbol)) return;

		const drafts = computeFormDrafts({
			orderType,
			limitPriceInput,
			tpSlEnabled,
			tpSlAllowed: canUseTpSl(orderType) && getMarketCapabilities(market).hasTpSl,
			tpPriceInput,
			slPriceInput,
			scalePreview,
			scaleStartInput,
			scaleEndInput,
			scaleLevels,
			scalePriceDist,
			scaleAmountDist,
			sizeValue,
			szDecimals,
		});

		for (const draft of drafts) {
			const extendData: LineOverlayExtendData = {
				getSegments: () => {
					const detail = previewDetailRef.current;
					if (!detail) return buildPreviewSegments(draft.kind, side);
					// Scale rungs show the size of ONE order (ladder / levels) — but only once
					// the ladder exists; a lone start/end line has no per-order size to show.
					const levels = draft.scaleLevels;
					const rungSize = levels && levels > 0 ? detail.size / levels : detail.size;
					const showSize = !draft.kind.startsWith("scale") || levels !== undefined;
					const sizeText =
						draft.rungSizeText ??
						(showSize && rungSize > 0 ? formatSizeForOrder(rungSize, detail.szDecimals) : undefined);
					return buildPreviewSegments(draft.kind, side, {
						price: draft.price,
						size: rungSize,
						sizeText,
						refPrice: detail.refPrice,
					});
				},
				// Drag release: write the new price into the matching form field — the
				// field (and every derived figure, validation, metric) updates from there.
				onDragEnd: (next) => {
					if (!Number.isFinite(next) || next <= 0) return;
					const text = formatPriceForOrder(next);
					if (draft.kind === "limit") setLimitPrice(text);
					else if (draft.kind === "tp") setTpPrice(text);
					else if (draft.kind === "sl") setSlPrice(text);
					else if (draft.kind === "scaleStart") setScaleStart(text);
					else if (draft.kind === "scaleEnd") setScaleEnd(text);
					else setDragNonce((n) => n + 1); // middle rung: spring back (no per-level field)
				},
			};
			chart.createOverlay({
				name: PREVIEW_LINE_NAME,
				points: [{ value: draft.price }],
				modeSensitivity: 0,
				styles: TRANSPARENT_OVERLAY_STYLES,
				extendData,
			});
		}
	}, [
		chartRef,
		symbol,
		marketName,
		market,
		side,
		orderType,
		limitPriceInput,
		tpSlEnabled,
		tpPriceInput,
		slPriceInput,
		scaleStartInput,
		scaleEndInput,
		scaleLevels,
		scalePreview,
		setLimitPrice,
		setTpPrice,
		setSlPrice,
		setScaleStart,
		setScaleEnd,
		dragNonce,
		chartEpoch,
		sizeValue,
		szDecimals,
		scalePriceDist,
		scaleAmountDist,
	]);
}

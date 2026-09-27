/**
 * Price ↔ pixel calibration for the TradingView Charting Library widget.
 *
 * The library runs in a (same-origin blob) iframe with NO public price→pixel API,
 * so we build a linear fit from two facts we CAN read:
 *  - `getVisiblePriceRange()` on the pane's right price scale (prices), and
 *  - the price plot's DOM rect inside the iframe (`.chart-gui-wrapper`, excluding
 *    the `.price-axis`), mapped into viewport space through the iframe's rect.
 *
 * Measurement results are in VIEWPORT coordinates; row positions subtract the
 * host rect each frame.
 */

export interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

/** Plain client-rect shape (what getBoundingClientRect returns). */
export interface OffsetRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface TvMeasurement {
	/** Price plot rectangle (excl. toolbar/axis/time axis), viewport coords. */
	plot: Rect;
	/**
	 * The PRICE pane only. With extra panes (TradingView's default volume study)
	 * `plot` spans them all, so a fit against it pushes every price down by the
	 * volume pane's height and lets dragged lines be dropped on top of it. The
	 * price axis belongs to the main pane, so its rect is the reliable pane box;
	 * falls back to `plot` when no axis element is measurable.
	 */
	pane: Rect;
	/** Price axis rectangle, viewport coords. */
	axis: Rect;
	/** Highest visible price (maps to plot.top). */
	priceTop: number;
	/** Lowest visible price (maps to plot.bottom). */
	priceBottom: number;
}

export interface TvMeasurementInput {
	iframeRect: OffsetRect;
	/** `.chart-gui-wrapper` rect in iframe-content coords. */
	guiRect: OffsetRect;
	/** `.price-axis` rect in iframe-content coords (null → width fallback). */
	axisRect: OffsetRect | null;
	range: { from: number; to: number };
}

/** Pure: combine iframe DOM rects + the visible price range into a viewport-space fit. */
export function buildTvMeasurement(input: TvMeasurementInput): TvMeasurement | null {
	const { iframeRect, guiRect, axisRect } = input;
	const axisWidth = axisRect ? axisRect.width : 60;
	const plotLeft = iframeRect.left + guiRect.left;
	const plotTop = iframeRect.top + guiRect.top;
	const plotBottom = plotTop + guiRect.height;
	const guiRight = plotLeft + guiRect.width;
	const axisLeft = axisRect ? iframeRect.left + axisRect.left : iframeRect.left + iframeRect.width - axisWidth;
	const plot: Rect = {
		left: plotLeft,
		top: plotTop,
		right: Math.min(guiRight, axisLeft),
		bottom: plotBottom,
		width: 0,
		height: 0,
	};
	plot.width = plot.right - plot.left;
	plot.height = plot.bottom - plot.top;
	if (!(plot.height > 30) || !(plot.width > 30)) return null;

	// Price pane = the main pane's box (taken from its price axis when present).
	const paneTop = axisRect ? iframeRect.top + axisRect.top : plot.top;
	const paneHeight = axisRect ? axisRect.height : plot.height;
	const pane: Rect = {
		left: plot.left,
		top: paneTop,
		right: plot.right,
		bottom: paneTop + paneHeight,
		width: plot.width,
		height: paneHeight,
	};
	if (!(pane.height > 20)) return null;

	const priceTop = Math.max(input.range.from, input.range.to);
	const priceBottom = Math.min(input.range.from, input.range.to);
	if (!Number.isFinite(priceTop) || !Number.isFinite(priceBottom) || priceTop <= priceBottom) return null;

	const axis: Rect = axisRect
		? {
				left: axisLeft,
				top: iframeRect.top + axisRect.top,
				right: iframeRect.left + axisRect.left + axisRect.width,
				bottom: iframeRect.top + axisRect.top + axisRect.height,
				width: axisRect.width,
				height: axisRect.height,
			}
		: {
				left: axisLeft,
				top: plot.top,
				right: iframeRect.left + iframeRect.width,
				bottom: plot.bottom,
				width: axisWidth,
				height: plot.height,
			};

	return { plot, pane, axis, priceTop, priceBottom };
}

/** Viewport y for a price (extrapolates outside the visible range, like the canvas charts). */
export function tvPriceToViewportY(m: TvMeasurement, price: number): number {
	const t = (m.priceTop - price) / (m.priceTop - m.priceBottom);
	return m.pane.top + t * m.pane.height;
}

/** Price at a viewport y (linear inverse of tvPriceToViewportY). */
export function tvViewportYToPrice(m: TvMeasurement, y: number): number {
	const t = (y - m.pane.top) / m.pane.height;
	return m.priceTop - t * (m.priceTop - m.priceBottom);
}

/**
 * DOM glue: read the iframe's plot/axis rects + the widget's visible price range.
 * Called EVERY animation frame (rows must track pans/zooms without lag), so an
 * optional cache skips the DOM queries — elements are re-resolved only when they
 * disconnect (widget rebuilds its iframe on symbol changes).
 */
export interface MeasureCache {
	iframe?: HTMLIFrameElement | null;
	gui?: Element | null;
	axis?: Element | null;
}

export function measureTvChart(
	container: HTMLElement,
	getRange: () => { from: number; to: number } | null,
	cache?: MeasureCache,
): TvMeasurement | null {
	let iframe: HTMLIFrameElement | undefined | null = cache?.iframe;
	if (!iframe?.isConnected) {
		iframe = undefined;
		if (cache) {
			cache.gui = undefined;
			cache.axis = undefined;
		}
		for (const frame of container.querySelectorAll("iframe")) {
			const r = frame.getBoundingClientRect();
			if (r.width > 300 && r.height > 300) {
				iframe = frame as HTMLIFrameElement;
				break;
			}
		}
		if (cache) cache.iframe = iframe ?? null;
	}
	if (!iframe) return null;
	const iframeRect = iframe.getBoundingClientRect();
	const doc = iframe.contentDocument;
	if (!doc) return null;
	let gui = cache?.gui;
	if (!gui?.isConnected) {
		gui = doc.querySelector(".chart-gui-wrapper");
		if (cache) cache.gui = gui;
	}
	if (!gui) return null;
	const guiRect = gui.getBoundingClientRect();
	let axisEl = cache?.axis;
	if (!axisEl?.isConnected) {
		axisEl = doc.querySelector(".price-axis");
		if (cache) cache.axis = axisEl;
	}
	const axisRect = axisEl ? axisEl.getBoundingClientRect() : null;
	const range = getRange();
	if (!range) return null;
	return buildTvMeasurement({
		iframeRect: { left: iframeRect.left, top: iframeRect.top, width: iframeRect.width, height: iframeRect.height },
		guiRect: { left: guiRect.left, top: guiRect.top, width: guiRect.width, height: guiRect.height },
		axisRect: axisRect
			? { left: axisRect.left, top: axisRect.top, width: axisRect.width, height: axisRect.height }
			: null,
		range,
	});
}

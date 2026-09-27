import type { CSSProperties } from "react";
import type { LabelSegment, LineOverlayResolution } from "@/domain/trade/order/chart-labels";
import {
	LABEL_BOX_HEIGHT,
	LABEL_FONT,
	LABEL_PAD_X,
	LABEL_PAD_Y,
	type StripTone,
	toneFilledColors,
	toneTextColor,
} from "@/lib/chart/label-style";

/**
 * DOM twin of klinecharts' bordered label strip — same metrics, same tone colors
 * (through the CSS custom properties getChartColors reads), same cell dividers —
 * used by the TradingView overlay layer.
 */
export function LabelStrip({
	segments,
	isBuy,
	className,
	style,
}: {
	segments: LabelSegment[];
	isBuy: boolean;
	className?: string;
	style?: CSSProperties;
}) {
	const border = isBuy ? "var(--market-up)" : "var(--market-down)";
	return (
		<span
			className={className}
			style={{
				// Hug the content (the compact label you see on desktop) but never
				// exceed the width the overlay gives us: on a phone the content is
				// wider than the box, and without the cap the ✕ used to spill past
				// the plot and land outside the clickable strip.
				// Hug the content (the compact desktop label) but never exceed the width
				// the overlay gives us: on a phone the content is wider than the box,
				// and uncapped it spilled across the plot with the ✕ outside the strip.
				display: "inline-flex",
				maxWidth: "100%",
				overflow: "hidden",
				alignItems: "stretch",
				border: `1px solid ${border}`,
				background: "var(--bg-raised)",
				font: LABEL_FONT,
				lineHeight: "1",
				whiteSpace: "nowrap",
				...style,
			}}
		>
			{segments.map((segment, index) => {
				const filled = segment.filled === true;
				const filledColors = filled ? toneFilledColors(segment.tone as StripTone) : null;
				return (
					<span
						key={segment.key ?? `${segment.text}-${index}`}
						data-box-key={segment.key}
						// The visible cell is a thin strip; on touch, grow the ✕ hit area
						// with an invisible pseudo layer (styles in the style prop can't).
						className={
							segment.key === "cancel"
								? "after:content-[''] after:absolute after:-inset-y-2.5 after:-inset-x-1.5"
								: undefined
						}
						style={{
							display: "inline-flex",
							alignItems: "center",
							flexShrink: index === 0 ? 1 : 0,
							minWidth: 0,
							overflow: index === 0 ? "hidden" : undefined,
							textOverflow: index === 0 ? "ellipsis" : undefined,
							padding: `${LABEL_PAD_Y}px ${LABEL_PAD_X}px`,
							height: `${LABEL_BOX_HEIGHT}px`,
							color: filledColors ? filledColors.color : toneTextColor(segment.tone as StripTone),
							backgroundColor: filledColors ? filledColors.background : "transparent",
							borderLeft: index > 0 ? `1px solid ${border}` : undefined,
							position: "relative",
							...(segment.key ? { cursor: "pointer" } : {}),
						}}
					>
						{segment.text}
					</span>
				);
			})}
		</span>
	);
}

/** Shared row shape: segments + side for any resolution (drafts, orders, position, ghost). */
export function stripFromResolution(resolution: LineOverlayResolution): {
	segments: LabelSegment[];
	isBuy: boolean;
} {
	return { segments: resolution.segments, isBuy: resolution.isBuy };
}

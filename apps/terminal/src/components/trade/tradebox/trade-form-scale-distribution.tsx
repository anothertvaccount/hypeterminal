import { t } from "@lingui/core/macro";
import { type PointerEvent as ReactPointerEvent, useRef } from "react";
import {
	matchScalePreset,
	SCALE_DIST_AMOUNT_PRESETS,
	SCALE_DIST_NODE_COUNT,
	SCALE_DIST_PRICE_PRESETS,
} from "@/domain/trade/order/scale-distribution";
import { cn } from "@/lib/cn";

const SVG_W = 260;
const SVG_H = 56;
const NODE_R = 4.5;
/**
 * Invisible grab area around each node. The visual node is ~9px in viewBox units
 * (≈16px on a phone) — far too small for a finger, and the price curve only has
 * three draggable nodes to begin with, so a missed grab feels like "it doesn't
 * work". ~13 units renders ≈45px on a 390px-wide phone.
 */
const NODE_TOUCH_R = 13;
/** Minimum gap between adjacent price nodes — keeps the curve monotonic. */
const PRICE_NODE_EPSILON = 0.02;

interface Props {
	kind: "price" | "amount";
	label: string;
	/** Curve nodes (null = flat/uniform). Persisted in the order-entry store. */
	nodes: number[] | null;
	onNodes: (nodes: number[] | null) => void;
	disabled: boolean;
}

function presetsFor(kind: Props["kind"]) {
	return kind === "price" ? SCALE_DIST_PRICE_PRESETS : SCALE_DIST_AMOUNT_PRESETS;
}

function defaultNodes(kind: Props["kind"]): readonly number[] {
	return presetsFor(kind).flat;
}

/**
 * step-curve distribution curve: a preset (Flat / Start / End) or drag your
 * own nodes. Price curves pin both ends (the ladder always spans exactly
 * start…end) and stay monotonic while dragging; amount curves are free weights.
 * The curve feeds BOTH the on-canvas ladder preview and the submitted orders —
 * they can never disagree.
 */
export function ScaleDistributionField({ kind, label, nodes, onNodes, disabled }: Props) {
	const svgRef = useRef<SVGSVGElement>(null);
	const presets = presetsFor(kind);
	const active = matchScalePreset(nodes, presets);
	const curve = nodes ?? defaultNodes(kind);
	const count = SCALE_DIST_NODE_COUNT;

	const points = curve.map((value, index) => ({
		x: NODE_R + 2 + (index / (count - 1)) * (SVG_W - (NODE_R + 2) * 2),
		y: NODE_R + 2 + (1 - value) * (SVG_H - (NODE_R + 2) * 2),
	}));
	const polyline = points.map((p) => `${p.x},${p.y}`).join(" ");

	function valueAt(clientY: number): number | null {
		const svg = svgRef.current;
		if (!svg) return null;
		const rect = svg.getBoundingClientRect();
		if (rect.height <= 0) return null;
		const value = 1 - (clientY - rect.top) / rect.height;
		return Math.min(Math.max(value, 0), 1);
	}

	function handleDown(pinned: boolean) {
		return (event: ReactPointerEvent<SVGCircleElement>) => {
			if (disabled || pinned) return;
			event.currentTarget.setPointerCapture(event.pointerId);
		};
	}

	function handleMove(index: number) {
		return (event: ReactPointerEvent<SVGCircleElement>) => {
			if (disabled) return;
			if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
			const value = valueAt(event.clientY);
			if (value === null) return;
			const current = curve;
			const next = [...current];
			if (kind === "price") {
				const lo = next[index - 1] + PRICE_NODE_EPSILON;
				const hi = next[index + 1] - PRICE_NODE_EPSILON;
				next[index] = Math.min(Math.max(value, lo), hi);
			} else {
				next[index] = value;
			}
			onNodes(next);
		};
	}

	return (
		<div className="space-y-1">
			<div className="flex items-center justify-between gap-2">
				<span className="text-2xs font-medium text-fg-muted uppercase tracking-wide">{label}</span>
				<div className="flex items-center gap-1">
					{(["flat", "start", "end"] as const).map((key) => (
						<button
							key={key}
							type="button"
							disabled={disabled}
							aria-label={`${label} ${key === "flat" ? "Flat" : key === "start" ? "Start" : "End"}`}
							onClick={() => onNodes(key === "flat" ? null : [...presets[key]])}
							className={cn(
								"px-1.5 py-0.5 rounded text-2xs font-semibold capitalize border cursor-pointer transition-colors disabled:opacity-40",
								active === key
									? "bg-fill-hover text-fg border-stroke-weak/60"
									: "border-transparent text-fg-muted hover:text-fg",
							)}
						>
							{key}
						</button>
					))}
					{active === "custom" && <span className="text-2xs text-fg-muted px-1">{t`Custom`}</span>}
				</div>
			</div>
			<svg
				ref={svgRef}
				viewBox={`0 0 ${SVG_W} ${SVG_H}`}
				width="100%"
				height={SVG_H}
				role="img"
				aria-label={`${label} curve`}
				className="rounded-6 border border-stroke-weak/40 bg-background touch-none"
			>
				<polyline
					points={polyline}
					fill="none"
					stroke="var(--fill-brand-strong)"
					strokeWidth={2}
					strokeLinejoin="round"
					strokeLinecap="round"
				/>
				{points.map((point, index) => {
					const pinned = kind === "price" && (index === 0 || index === count - 1);
					return (
						<g key={`${label}-node-${point.x}`}>
							{!pinned && !disabled && (
								<circle
									cx={point.x}
									cy={point.y}
									r={NODE_TOUCH_R}
									fill="transparent"
									style={{ cursor: "ns-resize", pointerEvents: "auto", touchAction: "none" }}
									onPointerDown={handleDown(pinned)}
									onPointerMove={handleMove(index)}
								/>
							)}
							<circle
								cx={point.x}
								cy={point.y}
								r={pinned ? 3 : NODE_R}
								fill={pinned ? "var(--text-weak)" : "var(--fill-brand-strong)"}
								stroke="var(--bg-raised)"
								strokeWidth={1}
								style={{
									cursor: disabled || pinned ? "not-allowed" : "ns-resize",
									pointerEvents: disabled ? "none" : "auto",
									touchAction: "none",
								}}
								onPointerDown={handleDown(pinned)}
								onPointerMove={handleMove(index)}
							/>
						</g>
					);
				})}
			</svg>
		</div>
	);
}

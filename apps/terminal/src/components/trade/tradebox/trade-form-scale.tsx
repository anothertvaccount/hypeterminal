import { t } from "@lingui/core/macro";
import { NumberInput } from "@/components/ui/number-input";
import { PriceInput } from "@/components/ui/price-input";
import { SCALE_LEVELS_MAX, SCALE_LEVELS_MIN } from "@/config/trade";
import { canPreviewScale } from "@/domain/trade/orders";
import { cn } from "@/lib/cn";
import {
	useOrderEntryActions,
	useScaleAmountDist,
	useScaleChartPickTarget,
	useScaleEnd,
	useScaleLevels,
	useScalePreview,
	useScalePriceDist,
	useScaleStart,
} from "@/stores/use-order-entry-store";
import { ScaleDistributionField } from "./trade-form-scale-distribution";

interface Props {
	markPx: number;
	szDecimals: number;
	disabled: boolean;
}

export function TradeFormScale({ markPx, szDecimals, disabled }: Props) {
	const scaleStartPriceInput = useScaleStart();
	const scaleEndPriceInput = useScaleEnd();
	const scaleLevelsNum = useScaleLevels();
	const scalePreview = useScalePreview();
	const scalePriceDist = useScalePriceDist();
	const scaleAmountDist = useScaleAmountDist();
	const scaleChartPickTarget = useScaleChartPickTarget();
	const { setScaleStart, setScaleEnd, setScaleLevels, setScalePreview, setScalePriceDist, setScaleAmountDist } =
		useOrderEntryActions();
	const canPreview = canPreviewScale(scaleStartPriceInput, scaleEndPriceInput, scaleLevelsNum);

	return (
		<>
			<PriceInput
				label={t`Start Price`}
				placeholder="0.00"
				value={scaleStartPriceInput}
				onChange={(e) => setScaleStart(e.target.value)}
				onMidClick={setScaleStart}
				midPrice={markPx}
				szDecimals={szDecimals}
				className="w-full text-xs tabular-nums"
				disabled={disabled}
			/>
			<PriceInput
				label={t`End Price`}
				placeholder="0.00"
				value={scaleEndPriceInput}
				onChange={(e) => setScaleEnd(e.target.value)}
				onMidClick={setScaleEnd}
				midPrice={markPx}
				szDecimals={szDecimals}
				className="w-full text-xs tabular-nums"
				disabled={disabled}
			/>
			<NumberInput
				label={t`Number of Orders`}
				labelValue={`${SCALE_LEVELS_MIN}–${SCALE_LEVELS_MAX}`}
				stepperLabel={t`Number of Orders`}
				showSteppers
				min={SCALE_LEVELS_MIN}
				max={SCALE_LEVELS_MAX}
				step={1}
				placeholder="4"
				value={String(scaleLevelsNum)}
				onChange={(e) => setScaleLevels(Number(e.target.value) || 4)}
				allowDecimals={false}
				className="w-full text-xs tabular-nums"
				disabled={disabled}
			/>
			<ScaleDistributionField
				kind="price"
				label={t`Price Distribution`}
				nodes={scalePriceDist}
				onNodes={setScalePriceDist}
				disabled={disabled}
			/>
			<ScaleDistributionField
				kind="amount"
				label={t`Amount Distribution`}
				nodes={scaleAmountDist}
				onNodes={setScaleAmountDist}
				disabled={disabled}
			/>
			<button
				type="button"
				aria-label={scalePreview ? t`Hide scale preview` : t`Preview scale orders`}
				onClick={() => setScalePreview(!scalePreview)}
				disabled={disabled || (!canPreview && !scalePreview)}
				className={cn(
					"w-full mt-1 px-2 py-1.5 rounded-6 border text-2xs font-semibold uppercase tracking-wide cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed",
					scalePreview
						? "border-stroke-weak/60 bg-fill-hover text-fg"
						: "border-stroke-weak/40 text-fg-muted hover:bg-fill-hover/40",
				)}
			>
				{scalePreview ? t`Hide preview` : t`Preview`}
			</button>
			<p className="text-2xs text-fg-muted text-center">
				{scaleChartPickTarget === "start"
					? t`Click the chart to set the Start Price`
					: t`Click the chart to set the End Price`}
			</p>
		</>
	);
}

import { Dropdown, type DropdownGroup } from "@hypeterminal/ui";
import { t } from "@lingui/core/macro";
import {
	CrosshairIcon,
	type Icon,
	LightningIcon,
	OctagonIcon,
	RowsIcon,
	TargetIcon,
	TimerIcon,
	XCircleIcon,
} from "@phosphor-icons/react";
import {
	ADVANCED_ORDER_GROUPS,
	ADVANCED_ORDER_TYPES,
	type AdvancedOrderType,
	type OrderType,
	SPOT_ALLOWED_TYPES,
} from "@/config/trade";
import { cn } from "@/lib/cn";
import type { MarketKind } from "@/lib/hyperliquid";
import { getAdvancedOrderLabel, getAdvancedOrderTypeLabel, isAdvancedOrderType } from "@/lib/trade/order-types";

interface Props {
	orderType: OrderType;
	onOrderTypeChange: (type: OrderType) => void;
	marketKind?: MarketKind;
	className?: string;
}

type AdvancedOrderOption = {
	value: AdvancedOrderType;
	label: string;
	icon: Icon;
	group: "trigger" | "execution";
};

const ADVANCED_ORDER_ICONS: Record<AdvancedOrderType, Icon> = {
	chaseLimit: LightningIcon,
	stopMarket: OctagonIcon,
	stopLimit: XCircleIcon,
	takeProfitMarket: TargetIcon,
	takeProfitLimit: CrosshairIcon,
	twap: TimerIcon,
	scale: RowsIcon,
};

function buildAdvancedOrderOptions(): AdvancedOrderOption[] {
	return ADVANCED_ORDER_TYPES.map((value) => ({
		value,
		label: getAdvancedOrderTypeLabel(value),
		icon: ADVANCED_ORDER_ICONS[value],
		group: ADVANCED_ORDER_GROUPS[value],
	}));
}

function getFilteredOptions(options: AdvancedOrderOption[], marketKind: MarketKind): AdvancedOrderOption[] {
	if (marketKind === "spot") {
		return options.filter((option) => SPOT_ALLOWED_TYPES.includes(option.value));
	}
	return options;
}

function toDropdownItems(options: AdvancedOrderOption[], onOrderTypeChange: (type: OrderType) => void) {
	return options.map((option) => ({
		label: option.label,
		icon: <option.icon className="size-3" />,
		onSelect: () => onOrderTypeChange(option.value),
	}));
}

export function AdvancedOrderDropdown({ orderType, onOrderTypeChange, marketKind = "perp", className }: Props) {
	const isAdvanced = isAdvancedOrderType(orderType);
	const label = getAdvancedOrderLabel(orderType, t`Other`);

	const options = buildAdvancedOrderOptions();
	const triggerOptions = getFilteredOptions(
		options.filter((option) => option.group === "trigger"),
		marketKind,
	);
	const executionOptions = getFilteredOptions(
		options.filter((option) => option.group === "execution"),
		marketKind,
	);
	const hasTriggerOptions = triggerOptions.length > 0;

	const groups: DropdownGroup[] = [
		...(hasTriggerOptions ? [{ label: t`Trigger`, items: toDropdownItems(triggerOptions, onOrderTypeChange) }] : []),
		{ label: t`Execution`, items: toDropdownItems(executionOptions, onOrderTypeChange) },
	];

	return (
		<Dropdown
			trigger={
				<span className={cn("inline-flex items-center outline-none hover:text-fg transition-colors", className)}>
					{isAdvanced ? label : t`Other`}
				</span>
			}
			groups={groups}
			align="end"
			className="min-w-0"
		/>
	);
}

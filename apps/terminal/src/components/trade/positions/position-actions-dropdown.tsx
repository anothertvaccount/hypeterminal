import { Dropdown } from "@hypeterminal/ui";
import { t } from "@lingui/core/macro";
import { ArrowsClockwiseIcon, LightningIcon, TagIcon, TimerIcon } from "@phosphor-icons/react";

interface Props {
	canClose: boolean;
	isRowClosing: boolean;
	onMarketClose: () => void;
	onLimitClose: () => void;
	/** Post-only chase close — keeps riding the touch until the position is flat. */
	onChaseClose: () => void;
	onReverse: () => void;
}

export function PositionActionsDropdown({
	canClose,
	isRowClosing,
	onMarketClose,
	onLimitClose,
	onChaseClose,
	onReverse,
}: Props) {
	return (
		<Dropdown
			className="flex justify-end text-xs text-fg-muted"
			triggerVariant="minimal"
			triggerClassName="font-medium"
			triggerAriaLabel={t`Position close actions`}
			trigger={isRowClosing ? t`Closing...` : t`Close`}
			disabled={!canClose || isRowClosing}
			align="end"
			groups={[
				{
					items: [
						{
							label: t`Market Close`,
							icon: <LightningIcon className="size-3.5" />,
							onSelect: onMarketClose,
						},
						{
							label: t`Limit Close`,
							icon: <TagIcon className="size-3.5" />,
							onSelect: onLimitClose,
						},
						{
							label: t`Chase Close`,
							icon: <TimerIcon className="size-3.5" />,
							onSelect: onChaseClose,
						},
					],
				},
				{
					items: [
						{
							label: t`Reverse`,
							icon: <ArrowsClockwiseIcon className="size-3.5" />,
							onSelect: onReverse,
						},
					],
				},
			]}
		/>
	);
}

import {
	Button,
	Modal,
	ModalContent,
	ModalHeader,
	ModalPopup,
	ModalTitle,
	SegmentedControlItem,
	SegmentedControls,
	Select,
	Slider,
	Toggle,
} from "@hypeterminal/ui";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { XIcon } from "@phosphor-icons/react";
import type { ChangeEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import { NumberInput } from "@/components/ui/number-input";
import { HOTKEYS } from "@/config/hotkeys";
import { type LocaleCode, localeList, type NumberFormatLocale, numberFormatLocaleList } from "@/config/i18n";
import {
	DEFAULT_SIZE_BUTTON_AMOUNTS,
	MARKET_ORDER_SLIPPAGE_MAX_PERCENT,
	MARKET_ORDER_SLIPPAGE_MIN_PERCENT,
} from "@/config/trade";
import { cn } from "@/lib/cn";
import { comboDisplay } from "@/lib/hotkeys/engine";
import { isCustomBinding, resolveCombo, serializeHotkeyEvent } from "@/lib/hotkeys/resolve";
import { dynamicActivate } from "@/lib/i18n";
import { useSettingsDialogActions, useSettingsDialogOpen } from "@/stores/use-global-modal-store";
import {
	useDefaultLimitSizeUsd,
	useGlobalSettings,
	useGlobalSettingsActions,
	useMarketOrderSlippagePercent,
	useNetwork,
	useSizeButtonAmounts,
} from "@/stores/use-global-settings-store";
import {
	useHotkeyOverrides,
	useHotkeySettingsActions,
	useHotkeysCapturingId,
	useHotkeysEnabled,
} from "@/stores/use-hotkey-settings-store";

export function GlobalSettingsModal() {
	const open = useSettingsDialogOpen();
	const { close } = useSettingsDialogActions();
	const { i18n } = useLingui();
	const slippagePercent = useMarketOrderSlippagePercent();
	const { showOrderbookInQuote, numberFormatLocale } = useGlobalSettings();
	const {
		setShowOrderbookInQuote,
		setNumberFormatLocale,
		setMarketOrderSlippagePercent,
		setNetwork,
		setSizeButtonAmounts,
		setDefaultLimitSizeUsd,
	} = useGlobalSettingsActions();
	const network = useNetwork();

	const [localSlippageInput, setLocalSlippageInput] = useState<string | null>(null);
	const defaultLimitSizeUsd = useDefaultLimitSizeUsd();
	const [localDefaultLimitSize, setLocalDefaultLimitSize] = useState<string | null>(null);
	const defaultLimitSizeDisplay = localDefaultLimitSize ?? String(defaultLimitSizeUsd);
	const sizeButtonAmounts = useSizeButtonAmounts();
	const [localSizeAmounts, setLocalSizeAmounts] = useState<string[] | null>(null);
	const sizeAmountsDisplay = localSizeAmounts ?? sizeButtonAmounts.map(String);

	function handleSizeAmountChange(index: number, raw: string) {
		setLocalSizeAmounts(sizeAmountsDisplay.map((value, i) => (i === index ? raw : value)));
		const parsed = Number(raw);
		if (!Number.isFinite(parsed) || parsed <= 0) return;
		setSizeButtonAmounts(sizeButtonAmounts.map((amount, i) => (i === index ? parsed : amount)));
	}

	function handleSizeAmountBlur() {
		setLocalSizeAmounts(null);
	}

	function resetSizeButtons() {
		setLocalSizeAmounts(null);
		setSizeButtonAmounts([...DEFAULT_SIZE_BUTTON_AMOUNTS]);
	}
	const [page, setPage] = useState<"general" | "hotkeys">("general");
	const slippageInputValue = localSlippageInput ?? String(slippagePercent);

	function handleSlippageInputChange(event: ChangeEvent<HTMLInputElement>) {
		const nextValue = event.target.value;
		setLocalSlippageInput(nextValue);
		if (nextValue.trim() === "") return;
		const parsed = Number(nextValue);
		if (Number.isFinite(parsed)) setMarketOrderSlippagePercent(parsed);
	}

	function handleSlippageInputBlur() {
		setLocalSlippageInput(null);
	}

	function handleDefaultLimitSizeChange(event: ChangeEvent<HTMLInputElement>) {
		setLocalDefaultLimitSize(event.target.value);
		if (event.target.value.trim() === "") return;
		const parsed = Number(event.target.value);
		if (Number.isFinite(parsed) && parsed > 0) setDefaultLimitSizeUsd(parsed);
	}

	function handleDefaultLimitSizeBlur() {
		setLocalDefaultLimitSize(null);
	}

	function handleSlippageSliderChange(value: number | readonly number[]) {
		const nextValue = Array.isArray(value) ? value[0] : value;
		if (typeof nextValue === "number" && nextValue !== slippagePercent) {
			setMarketOrderSlippagePercent(nextValue);
		}
	}

	function handleLanguageChange(value: string | null) {
		if (value) dynamicActivate(value as LocaleCode);
	}

	function handleNumberFormatChange(value: string | null) {
		if (value) setNumberFormatLocale(value as NumberFormatLocale);
	}

	const languageOptions = localeList.map(({ code, name }) => ({ value: code, label: name }));
	const numberFormatOptions = numberFormatLocaleList.map(({ code, name }) => ({ value: code, label: name }));

	return (
		<Modal open={open} onOpenChange={close}>
			<ModalPopup size="sm">
				<ModalHeader>
					<ModalTitle>{t`Settings`}</ModalTitle>
				</ModalHeader>

				<ModalContent className="space-y-6 max-h-[70vh] overflow-y-auto">
					<SegmentedControls value={page} onValueChange={(value) => setPage(value as "general" | "hotkeys")} size="xxs">
						<SegmentedControlItem value="general">{t`General`}</SegmentedControlItem>
						<SegmentedControlItem value="hotkeys">{t`Hotkeys`}</SegmentedControlItem>
					</SegmentedControls>
					{page === "general" ? (
						<>
							<SettingsGroup label={t`Trading`}>
								<div className="space-y-2.5">
									<div className="flex items-center justify-between gap-3">
										<span className="text-xs text-fg">{t`Slippage tolerance`}</span>
										<div className="flex items-center gap-1 shrink-0">
											<NumberInput
												value={slippageInputValue}
												onChange={handleSlippageInputChange}
												onBlur={handleSlippageInputBlur}
												min={MARKET_ORDER_SLIPPAGE_MIN_PERCENT}
												max={MARKET_ORDER_SLIPPAGE_MAX_PERCENT}
												maxAllowedDecimals={2}
												inputSize="sm"
												className="w-16 text-right tabular-nums"
											/>
											<span className="text-xs text-fg-muted">%</span>
										</div>
									</div>
									<Slider
										value={[slippagePercent]}
										onValueChange={handleSlippageSliderChange}
										min={MARKET_ORDER_SLIPPAGE_MIN_PERCENT}
										max={MARKET_ORDER_SLIPPAGE_MAX_PERCENT}
										step={0.1}
										thumbSize="sm"
									/>
									<div className="flex items-center justify-between text-2xs tabular-nums text-fg-muted">
										<span>{MARKET_ORDER_SLIPPAGE_MIN_PERCENT}%</span>
										<span>{MARKET_ORDER_SLIPPAGE_MAX_PERCENT}%</span>
									</div>
								</div>
							</SettingsGroup>

							<SettingsGroup label={t`Size buttons`}>
								<div className="space-y-1.5">
									<p className="text-xs text-fg">{t`Quick add amounts (USD)`}</p>
									<div className="flex flex-wrap items-center gap-1.5">
										{SIZE_AMOUNT_SLOTS.map((slot) => (
											<NumberInput
												key={`size-amount-${slot}`}
												value={sizeAmountsDisplay[slot] ?? ""}
												onChange={(event) => handleSizeAmountChange(slot, event.target.value)}
												onBlur={handleSizeAmountBlur}
												min={1}
												maxAllowedDecimals={2}
												inputSize="sm"
												className="w-16 text-right tabular-nums"
											/>
										))}
										<Button variant="outline" intent="neutral" size="sm" onClick={resetSizeButtons}>
											{t`Reset`}
										</Button>
									</div>
									<p className="text-2xs text-fg-muted text-pretty">
										{t`Each click adds its amount to the order size; CC clears the size. Spot sizes are not USD-denominated, so the row only shows for perps.`}
									</p>
								</div>
							</SettingsGroup>

							<SettingsGroup label={t`Default size`}>
								<SettingRow
									label={t`Limit order size (USD)`}
									hint={t`Fills the size field when you switch to Limit with an empty size`}
								>
									<NumberInput
										value={defaultLimitSizeDisplay}
										onChange={handleDefaultLimitSizeChange}
										onBlur={handleDefaultLimitSizeBlur}
										min={1}
										maxAllowedDecimals={2}
										inputSize="sm"
										className="w-20 text-right tabular-nums"
									/>
								</SettingRow>
							</SettingsGroup>

							<SettingsGroup label={t`Display`}>
								<SettingRow label={t`Order book in quote asset`}>
									<Toggle size="xs" checked={showOrderbookInQuote} onCheckedChange={setShowOrderbookInQuote} />
								</SettingRow>
								<SettingRow label={t`Display language`}>
									<Select
										value={i18n.locale}
										onValueChange={handleLanguageChange}
										options={languageOptions}
										size="xs"
										triggerClassName="min-w-32"
									/>
								</SettingRow>
								<SettingRow label={t`Number format`}>
									<Select
										value={numberFormatLocale}
										onValueChange={handleNumberFormatChange}
										options={numberFormatOptions}
										size="xs"
										triggerClassName="min-w-32"
									/>
								</SettingRow>
							</SettingsGroup>

							<SettingsGroup label={t`Network`}>
								<SettingRow label={t`Environment`} hint={t`Page reloads when changed`}>
									<SegmentedControls
										value={network}
										onValueChange={(value) => setNetwork(value as "mainnet" | "testnet")}
										size="xxs"
									>
										<SegmentedControlItem value="mainnet">{t`Mainnet`}</SegmentedControlItem>
										<SegmentedControlItem value="testnet">{t`Testnet`}</SegmentedControlItem>
									</SegmentedControls>
								</SettingRow>
							</SettingsGroup>
						</>
					) : (
						<HotkeysSettingsSection />
					)}
				</ModalContent>
			</ModalPopup>
		</Modal>
	);
}

/** Fixed positional slots for the size-amount inputs (stable React keys). */
const SIZE_AMOUNT_SLOTS = [0, 1, 2, 3, 4] as const;

interface SettingsGroupProps {
	label: string;
	children: ReactNode;
}

function SettingsGroup({ label, children }: SettingsGroupProps) {
	return (
		<section className="space-y-3">
			<h3 className="text-2xs font-semibold uppercase tracking-wider text-fg-muted">{label}</h3>
			<div className="space-y-2">{children}</div>
		</section>
	);
}

interface SettingRowProps {
	label: string;
	hint?: string;
	children: ReactNode;
}

function SettingRow({ label, hint, children }: SettingRowProps) {
	return (
		<div className="space-y-1">
			<div className="flex items-center justify-between gap-3 min-h-7">
				<span className="text-xs text-fg min-w-0">{label}</span>
				<div className="shrink-0">{children}</div>
			</div>
			{hint && <p className="text-2xs text-fg-muted text-pretty">{hint}</p>}
		</div>
	);
}

function HotkeysSettingsSection() {
	const enabled = useHotkeysEnabled();
	const overrides = useHotkeyOverrides();
	const capturingId = useHotkeysCapturingId();
	const { setEnabled, setBinding, clearBindings, setCapturing } = useHotkeySettingsActions();

	// Capture mode: the next real keydown becomes this action's combo (Esc/Backspace
	// cancels, bare modifiers keep waiting). The global hotkey listener stands down
	// while capturingId is set, so nothing else fires on the captured key.
	useEffect(() => {
		if (!capturingId) return;
		function handleCapture(event: KeyboardEvent) {
			// Guard inside the handler: TS keeps narrowing within the function scope.
			const targetId = capturingId;
			if (targetId === null) return;
			event.preventDefault();
			event.stopPropagation();
			if (event.key === "Escape" || event.key === "Backspace") {
				setCapturing(null);
				return;
			}
			const combo = serializeHotkeyEvent(event);
			if (!combo) return;
			setBinding(targetId, combo);
			setCapturing(null);
		}
		window.addEventListener("keydown", handleCapture);
		return () => window.removeEventListener("keydown", handleCapture);
	}, [capturingId, setBinding, setCapturing]);

	const bindable = HOTKEYS.filter((hotkey) => hotkey.availability === "available");
	const readOnly = HOTKEYS.filter((hotkey) => hotkey.availability !== "available");

	return (
		<div className="space-y-6">
			<SettingsGroup label={t`Hotkeys`}>
				<SettingRow label={t`Enable hotkeys`} hint={t`Master switch — same as the keyboard button in the top bar`}>
					<Toggle size="xs" checked={enabled} onCheckedChange={(next) => setEnabled(next === true)} />
				</SettingRow>
				<SettingRow label={t`Restore default keys`} hint={t`The classic defaults`}>
					<Button variant="outline" intent="neutral" size="sm" onClick={clearBindings}>
						{t`Reset`}
					</Button>
				</SettingRow>
			</SettingsGroup>

			<SettingsGroup label={t`Bindings`}>
				{bindable.map((hotkey) => {
					const combo = resolveCombo(hotkey.id, overrides);
					const capturing = capturingId === hotkey.id;
					return (
						<SettingRow key={hotkey.id} label={hotkey.label} hint={hotkey.note}>
							<div className="flex items-center gap-1.5">
								{isCustomBinding(hotkey.id, overrides) && !capturing && (
									<span className="text-2xs text-warning">{t`custom`}</span>
								)}
								<button
									type="button"
									aria-label={`Rebind ${hotkey.label}`}
									className={cn(
										"min-w-28 px-2 py-1 rounded-xs border font-mono text-2xs text-center cursor-pointer transition-colors",
										capturing
											? "border-stroke-warning-strong/60 bg-warning-soft text-warning animate-pulse"
											: "border-stroke-weak bg-fill-hover text-fg hover:bg-fill-hover/70",
									)}
									onClick={() => setCapturing(capturing ? null : hotkey.id)}
								>
									{capturing ? t`Press a key…` : combo !== null ? comboDisplay(combo) : t`Unbound`}
								</button>
								{combo !== null && !capturing && (
									<button
										type="button"
										aria-label={`Unbind ${hotkey.label}`}
										className="p-1 text-fg-muted hover:text-error transition-colors cursor-pointer"
										onClick={() => setBinding(hotkey.id, null)}
									>
										<XIcon className="size-3" />
									</button>
								)}
							</div>
						</SettingRow>
					);
				})}
			</SettingsGroup>

			{/* Only render when something is actually read-only — the group is empty
			    now that the unimplemented keys are gone from the config. */}
			{readOnly.length > 0 && (
				<SettingsGroup label={t`Not configurable`}>
					{readOnly.map((hotkey) => (
						<SettingRow key={hotkey.id} label={hotkey.label} hint={hotkey.note}>
							<span className="text-2xs text-fg-muted font-mono">
								{hotkey.combo !== null ? comboDisplay(hotkey.combo) : "—"}
							</span>
						</SettingRow>
					))}
				</SettingsGroup>
			)}

			<p className="text-2xs text-fg-muted text-pretty">
				{t`Click a key chip and press the new key; Esc cancels. Press ? in the terminal for the shortcut help.`}
			</p>
		</div>
	);
}

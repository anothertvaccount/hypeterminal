import { Button, Checkbox, Slider } from "@hypeterminal/ui";
import { t } from "@lingui/core/macro";
import { CaretDownIcon, PencilIcon, SpinnerGapIcon } from "@phosphor-icons/react";
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { useConnection, useSwitchChain, useWalletClient } from "wagmi";
import { NumberInput } from "@/components/ui/number-input";
import { PriceInput } from "@/components/ui/price-input";
import { FALLBACK_VALUE_PLACEHOLDER } from "@/config/app";
import { ARBITRUM_CHAIN_ID } from "@/config/contracts";
import { PAPER_TRADE } from "@/config/paper";
import { SIZE_PERCENT_OPTIONS } from "@/config/trade";
import { UI_TEXT } from "@/config/ui-text";
import { get24hChange, getPositionDex } from "@/domain/market";
import { getLiquidationInfo } from "@/domain/trade/order/metrics";
import { getOrderPrice } from "@/domain/trade/order/price";
import { getSliderValue } from "@/domain/trade/order/size";
import { increaseSizeByUsd } from "@/domain/trade/order/size-steps";
import { useFeeRates } from "@/hooks/trade/use-fee-rates";
import { useOrderEntryData } from "@/hooks/trade/use-order-entry-data";
import { useOrderSubmit } from "@/hooks/trade/use-order-submit";
import { cn } from "@/lib/cn";
import { formatPrice, formatToken, formatUSD, szDecimalsToPriceDecimals } from "@/lib/format";
import { useAgentRegistration, useAgentStatus, useSelectedMarketInfo, useTradingSession } from "@/lib/hyperliquid";
import type { MarginMode } from "@/lib/trade/margin-mode";
import { toNumberOrZero } from "@/lib/trade/numbers";
import {
	canUseTpSl as canUseTpSlForOrder,
	isScaleOrderType,
	isTakerOrderType,
	isTriggerOrderType,
	isTwapOrderType,
	usesLimitPrice as usesLimitPriceForOrder,
} from "@/lib/trade/order-types";
import type { ButtonContent, Side, SizeMode } from "@/lib/trade/types";
import { perpInput, spotInput, useOrderValidation } from "@/lib/trade/use-order-validation";
import { getValueColorClass } from "@/lib/ui/value-color";
import { useExchangeScope } from "@/providers/exchange-scope";
import { useSettingsDialogActions } from "@/stores/use-global-modal-store";
import {
	useMarketOrderSlippageBps,
	useMarketOrderSlippagePercent,
	useSizeButtonAmounts,
} from "@/stores/use-global-settings-store";
import { useMarketActions } from "@/stores/use-market-store";
import {
	useLimitPrice,
	useOrderEntryActions,
	useOrderSide,
	useOrderSize,
	useOrderType,
	useReduceOnly,
	useScaleAmountDist,
	useScaleEnd,
	useScaleLevels,
	useScalePriceDist,
	useScaleStart,
	useSizeMode,
	useSlPrice,
	useTif,
	useTpPrice,
	useTpSlEnabled,
	useTriggerPrice,
	useTwapMinutes,
	useTwapRandomize,
} from "@/stores/use-order-entry-store";
import { getOrderbookActionsStore, useSelectedPrice } from "@/stores/use-orderbook-actions-store";
import { TokenSelector } from "../chart/token-selector";
import { WalletModal } from "../components/wallet-modal";
import { ModeSwitch } from "../mode-switch";
import { MarginModeModal } from "../tradebox/margin-mode-modal";
import { OrderToast } from "../tradebox/order-toast";
import { TradeFormScale } from "../tradebox/trade-form-scale";
import { TradeFormTif } from "../tradebox/trade-form-tif";
import { TradeFormTpSl } from "../tradebox/trade-form-tp-sl";
import { TradeFormTwap } from "../tradebox/trade-form-twap";
import { TradeHeader } from "../tradebox/trade-header";
import { MobileBottomNavSpacer } from "./mobile-bottom-nav";

const ORDER_TEXT = UI_TEXT.ORDER_ENTRY;

interface Props {
	className?: string;
}

export function MobileTradeView({ className }: Props) {
	const { address, isConnected: isWallet } = useConnection();
	// A linked Phone Access key is a trading session with no wallet; `isActive`
	// covers both, while `address`/`isWallet` stay wallet-only for approvals.
	const { isActive } = useTradingSession();
	const { data: walletClient, isLoading: isWalletLoading, error: walletClientError } = useWalletClient();
	const { switchChain, isPending: isSwitchingChain } = useSwitchChain();

	const needsChainSwitch = !PAPER_TRADE && !!walletClientError && walletClientError.message.includes("does not match");

	const { data: market } = useSelectedMarketInfo();
	const { scope } = useExchangeScope();
	const { setSelectedMarket } = useMarketActions();

	function handleMarketChange(marketName: string) {
		setSelectedMarket(scope, marketName);
	}

	const { isReady: isAgentApproved, isLoading: isAgentStatusLoading, refetch: recheckAgentKey } = useAgentStatus();
	const { register: registerAgent, status: registerStatus } = useAgentRegistration();

	const canApprove = !!walletClient && !!address;
	const isRegistering =
		registerStatus === "approving_fee" || registerStatus === "approving_agent" || registerStatus === "verifying";

	const slippageBps = useMarketOrderSlippageBps();
	const slippagePercent = useMarketOrderSlippagePercent();

	const selectedPrice = useSelectedPrice();

	const orderType = useOrderType();
	const side = useOrderSide();
	// Shared store values written by the advanced sections (TIF, scale ladder,
	// TWAP, TP/SL prices) and by Chase Close prefill — mirrored at submit.
	const tif = useTif();
	const triggerPriceInput = useTriggerPrice();
	const scaleStartPriceInput = useScaleStart();
	const scaleEndPriceInput = useScaleEnd();
	const scaleLevelsNum = useScaleLevels();
	const scalePriceDist = useScalePriceDist();
	const scaleAmountDist = useScaleAmountDist();
	const twapMinutesNum = useTwapMinutes();
	const twapRandomize = useTwapRandomize();
	const tpPriceInput = useTpPrice();
	const slPriceInput = useSlPrice();
	const {
		setOrderType,
		setSide,
		setSize,
		setSizeMode: setStoreSizeMode,
		setLimitPrice,
		setTpSlEnabled,
		setReduceOnly,
		resetPrices,
	} = useOrderEntryActions();
	// Shared-store mirrors of the local fields (external writers: Chase Close
	// prefill, chart menu picks) — declared BEFORE the locals so a freshly mounted
	// form (mobile section switch) seeds from the store instead of starting empty.
	const storeSize = useOrderSize();
	const storeLimit = useLimitPrice();
	const storeReduceOnly = useReduceOnly();
	const storeTpSlEnabled = useTpSlEnabled();
	const storeSizeMode = useSizeMode();
	const [sizeInput, setSizeInput] = useState(storeSize);
	/**
	 * Bumped on every clear. Base UI's NumberField keeps its last numeric value when
	 * the controlled `value` becomes an empty string and re-emits it (on blur, or with
	 * the next change) — which re-populated the store, so the next $ chip ADDED to the
	 * pre-clear size. Remounting on clear gives the field a clean, empty state, so
	 * "$50" after a clear is $50.
	 */
	const [sizeClearNonce, setSizeClearNonce] = useState(0);
	/**
	 * The value that was on screen when the user last hit CC. The number field
	 * re-emits that exact value through onChange shortly after a clear (it keeps
	 * its last internal number), which re-populated the store, so the next $ chip
	 * added $50 to the PREVIOUS size instead of starting fresh. While this is set
	 * that one string is dropped; focusing the field clears it so retyping works.
	 */
	const staleSizeRef = useRef<string | null>(null);
	/**
	 * Generation counter for the size. The slider can deliver a LATE commit — a
	 * second onValueCommitted after the drag — and it used to land *after* CC, a
	 * chip, or a typed value, silently restoring the old size. Every deliberate
	 * write bumps the counter; the slider remembers the counter from when its
	 * gesture started and drops its commit if the size changed in between.
	 */
	const sizeEpochRef = useRef(0);
	const sliderEpochRef = useRef(0);
	const [sizeMode, setSizeMode] = useState<SizeMode>(storeSizeMode);
	const [limitPriceInput, setLimitPriceInput] = useState(storeLimit || "");
	const reduceOnly = storeReduceOnly;
	const [isDraggingSlider, setIsDraggingSlider] = useState(false);
	const [dragSliderValue, setDragSliderValue] = useState(0);
	const [approvalError, setApprovalError] = useState<string | null>(null);

	const canUseTpSl = canUseTpSlForOrder(orderType);

	// External writers (Chase Close prefill, chart menu picks) update the shared
	// store — mirror into the local mobile fields DURING render: submitOrderForm's
	// flushSync + requestSubmit runs before effects, so an effect-based sync would
	// be too late (validation would still see the stale local size).
	// The field and the store are ONE value. Everything external to the form (a
	// filled order resetting the form, a market switch, the Chase Close / chart
	// prefill) writes the STORE only, and the old mirror only reacted to store
	// CHANGES — so a prefill that wrote the value the store already held left the
	// field stale, validation failed with "Enter size", and a forced submit did
	// nothing at all. Re-adopt the store whenever the field no longer matches the
	// last value written, whatever the cause.
	const lastSizeWriteRef = useRef(storeSize);
	if (sizeInput !== lastSizeWriteRef.current) {
		lastSizeWriteRef.current = storeSize;
		setSizeInput(storeSize);
		if (import.meta.env.DEV) {
			(globalThis as { __hlSyncCount?: number }).__hlSyncCount =
				((globalThis as { __hlSyncCount?: number }).__hlSyncCount ?? 0) + 1;
		}
	}
	const prevStoreLimit = useRef(storeLimit);
	if (prevStoreLimit.current !== storeLimit) {
		prevStoreLimit.current = storeLimit;
		if (storeLimit) setLimitPriceInput(storeLimit);
	}
	const prevStoreSizeMode = useRef(storeSizeMode);
	if (prevStoreSizeMode.current !== storeSizeMode) {
		prevStoreSizeMode.current = storeSizeMode;
		setSizeMode(storeSizeMode);
	}
	const [walletModalOpen, setWalletModalOpen] = useState(false);
	const [showMarginDialog, setShowMarginDialog] = useState(false);
	const { open: openSettingsDialog } = useSettingsDialogActions();

	const { handleSubmit: submitOrder, isSubmitting } = useOrderSubmit();

	const usesLimitPrice = usesLimitPriceForOrder(orderType);
	const isMarketExecution = orderType === "market" || isTakerOrderType(orderType);
	const markPx = toNumberOrZero(market?.markPx);

	const {
		isSpotMarket,
		baseToken,
		quoteToken,
		capabilities,
		szDecimals,
		availableBalance,
		availableBalanceToken,
		spotBalance,
		maxSize,
		reduceOnlyPositionSzi,
		sizeValue,
		orderValue,
		sideLabels,
		getSizeForPercent,
		convertSizeForModeToggle,
		leverage,
		marginMode,
		hasPosition,
		currentLeverage,
		pendingLeverage,
		maxLeverage,
		setPendingLeverage,
		resetPendingLeverage,
		applyMarginAndLeverage,
		isSwitchingMode,
		switchModeError,
		// The STORE is the authority for everything derived (sizeValue, orderValue,
		// validation, what gets submitted). The local field is only the display/typing
		// surface, and it is re-adopted from the store above. Deriving from the local
		// meant a forced submit (Chase Close, a chart price pick) could read a size that
		// was one render behind the store and place the WRONG size.
	} = useOrderEntryData({ market, side, markPx, sizeMode, sizeInput: storeSize });

	// Refresh gap: seed the default limit size once when the form boots on Limit
	// with an empty size (orderType persists, size does not).
	const seededDefaultSizeRef = useRef(false);
	useEffect(() => {
		if (orderType !== "limit" || seededDefaultSizeRef.current) return;
		if (sizeInput.trim() !== "") {
			seededDefaultSizeRef.current = true;
			return;
		}
		if (sizeMode === "quote") {
			seededDefaultSizeRef.current = true;
			setOrderType("limit");
			return;
		}
		const reference = toNumberOrZero(limitPriceInput) > 0 ? toNumberOrZero(limitPriceInput) : markPx;
		if (!(reference > 0)) return;
		seededDefaultSizeRef.current = true;
		setOrderType("limit", { price: reference, szDecimals: market?.szDecimals ?? 0 });
	}, [orderType, sizeInput, sizeMode, limitPriceInput, markPx, market, setOrderType]);

	useEffect(() => {
		if (selectedPrice !== null) {
			setOrderType("limit", { price: Number(selectedPrice), szDecimals });
			setLimitPriceInput(String(selectedPrice));
			getOrderbookActionsStore().actions.clearSelectedPrice();
		}
	}, [selectedPrice, setOrderType, szDecimals]);
	// A chase limit prices itself from the mark/book at submit time (see
	// use-order-submit) — never ask the user to type a price first, or the
	// "Enter limit price" validation pins the submit button forever.
	const isChase = orderType === "chaseLimit";
	// The TP/SL validators compare against `price` — for a scale that reference is
	// the ladder's midpoint, not the (hidden) limit field, so a TP above every rung
	// and an SL below every rung validate correctly. Same helper as desktop.
	const price = getOrderPrice(
		orderType,
		markPx,
		limitPriceInput,
		triggerPriceInput,
		scaleStartPriceInput,
		scaleEndPriceInput,
	);
	const { takerRate, makerRate } = useFeeRates(market?.kind);
	const feeRate = isMarketExecution ? takerRate : makerRate;
	const feeRatePercent = `${(feeRate * 100).toFixed(4)}%`;
	const estimatedFee = orderValue * feeRate;
	const marginRequired = capabilities.isLeveraged && leverage > 0 ? orderValue / leverage : 0;

	const liqPrice = capabilities.isLeveraged ? getLiquidationInfo({ price, sizeValue, leverage, side }).liqPrice : null;

	const baseInput = {
		// A linked trading key counts as a connected session (the guard behind this input
		// gates the submit button).
		isConnected: isWallet || isAgentApproved,
		isWalletLoading,
		availableBalance,
		hasMarket: !!market,
		hasAssetIndex: typeof market?.assetId === "number",
		needsAgentApproval: !isAgentApproved,
		isReadyToTrade: isAgentApproved,
		price,
		sizeValue,
		orderValue,
		side,
		usesLimitPrice,
	};

	const validation = useOrderValidation(
		isSpotMarket
			? spotInput(baseInput, {
					baseAvailable: spotBalance.baseAvailable,
					quoteAvailable: spotBalance.quoteAvailable,
					baseToken,
					quoteToken,
				})
			: perpInput(baseInput, {
					orderType,
					markPx,
					reduceOnly,
					reduceOnlyPositionSzi,
					maxSize,
					usesTriggerPrice: false,
					triggerPriceNum: null,
					stopOrder: false,
					takeProfitOrder: false,
					scaleOrder: false,
					twapOrder: false,
					scaleStartPriceNum: null,
					scaleEndPriceNum: null,
					scaleLevelsNum: null,
					twapMinutesNum: null,
					tpSlEnabled: storeTpSlEnabled,
					canUseTpSl,
					tpPriceNum: toNumberOrZero(tpPriceInput),
					slPriceNum: toNumberOrZero(slPriceInput),
				}),
	);

	/** Single writer for the size so the stale-value guard resets on every change. */
	function writeSize(next: string) {
		staleSizeRef.current = null;
		sizeEpochRef.current += 1;
		lastSizeWriteRef.current = next;
		setSizeInput(next);
		setSize(next);
	}

	function applySizeFromPercent(pct: number) {
		if (maxSize <= 0) return;
		const next = getSizeForPercent(pct);
		writeSize(next);
	}

	function handleSizeModeToggle() {
		const newMode = sizeMode === "base" ? "quote" : "base";
		const convertedSize = convertSizeForModeToggle();
		setSizeMode(newMode);
		// The STORE has to flip with it. It keeps `size` + `sizeMode` as a pair, and
		// every store reader (chart preview, submitOrderForm, the remount that seeds
		// from the store) interprets `size` THROUGH `sizeMode`. Leaving the store on
		// "base" while this field holds a USD figure made a $500 order read as
		// 500,000 coins — the slider pinned at max and the size chips then appeared
		// to do nothing.
		setStoreSizeMode(newMode);
		if (convertedSize) writeSize(convertedSize);
	}

	function handleSwitchChain() {
		switchChain({ chainId: ARBITRUM_CHAIN_ID });
	}

	async function handleApprove() {
		if (isRegistering) return;
		setApprovalError(null);
		try {
			await registerAgent();
		} catch (error) {
			setApprovalError(error instanceof Error ? error.message : ORDER_TEXT.APPROVAL_ERROR_FALLBACK);
		}
	}

	async function handleSubmit(force = false) {
		if (import.meta.env.DEV) {
			(globalThis as { __hlMobileSubmit?: unknown }).__hlMobileSubmit = {
				canSubmit: validation.canSubmit,
				storeSize,
				storeLimit,
				synced: (globalThis as { __hlSyncCount?: number }).__hlSyncCount ?? 0,
				isSubmitting,
				force,
				market: Boolean(market),
				baseToken,
				sizeValue,
				errors: validation.errors,
			};
		}
		// `force` (set by submitOrderForm for chart picks / Chase Close) skips only
		// the in-flight guard — mirrors the desktop panel exactly.
		if (!validation.canSubmit || (isSubmitting && !force)) return;
		if (!market || !baseToken || typeof market.assetId !== "number") return;

		// Full desktop-equivalent input: order type (Chase Limit / Scale / TWAP /
		// stops), TIF, scale ladder + distributions, TP/SL numbers. The old
		// hand-built input here silently coerced everything to market/limit + Gtc.
		const succeeded = await submitOrder({
			market: {
				assetId: market.assetId,
				szDecimals: market.szDecimals,
				coin: market.name,
				dex: getPositionDex(market),
			},
			baseToken,
			side,
			orderType,
			sizeValue,
			price,
			markPx,
			slippageBps,
			reduceOnly,
			tif,
			leverage,
			marginMode,
			limitPriceInput,
			triggerPriceInput,
			scaleStartPriceInput,
			scaleEndPriceInput,
			scaleLevelsNum,
			scalePriceDist,
			scaleAmountDist,
			twapMinutesNum,
			twapRandomize,
			tpSlEnabled: storeTpSlEnabled,
			canUseTpSl,
			tpPriceNum: toNumberOrZero(tpPriceInput),
			slPriceNum: toNumberOrZero(slPriceInput),
			twapOrder: isTwapOrderType(orderType),
			scaleOrder: isScaleOrderType(orderType),
			triggerOrder: isTriggerOrderType(orderType),
		});

		if (succeeded) {
			setSizeInput("");
			setLimitPriceInput("");
			// The store feeds the canvas previews — clear it too, or a submitted
			// order's line would linger on the chart.
			resetPrices();
		}
	}

	const sliderValue = isDraggingSlider ? dragSliderValue : getSliderValue(sizeValue, maxSize);

	const buttonContent = getMobileOrderButtonContent({
		isConnected: isWallet || isAgentApproved,
		needsChainSwitch,
		isSwitchingChain,
		availableBalance,
		needsApproval: validation.needsApproval,
		// A linked key can be re-checked, never approved, without a signing wallet.
		canApproveOnDevice: isWallet,
		onRecheckKey: () => void recheckAgentKey(),
		isRegistering: isRegistering || isAgentStatusLoading,
		canSubmit: validation.canSubmit,
		canApprove,
		isSubmitting,
		side,
		sideLabel: sideLabels[side],
		onConnect: () => setWalletModalOpen(true),
		onSwitchChain: handleSwitchChain,
		onApprove: handleApprove,
		onSubmit: handleSubmit,
	});

	// Phone Access: an approved linked key lets you trade with NO wallet connected.
	const canTrade = isWallet || isAgentApproved;
	const isFormDisabled = !canTrade || availableBalance <= 0;
	// Desktop form parity: quick size buttons, post-only selector, and the
	// advanced order-type sections (scale ladder, TWAP, full TP/SL rows).
	const scaleOrder = isScaleOrderType(orderType);
	const twapOrder = isTwapOrderType(orderType);
	const showTif = orderType === "limit" || orderType === "scale" || orderType === "chaseLimit";
	const sizeButtonAmounts = useSizeButtonAmounts();

	function handleAddSize(amountUsd: number) {
		// Quote mode: the field IS USD. Base mode: orderValue is the USD equivalent.
		// Quote mode: the field IS USD — read it from the store, the authority above.
		const currentUsd = sizeMode === "quote" ? toNumberOrZero(storeSize) : orderValue;
		const next = increaseSizeByUsd({ currentUsd, amountUsd, markPx, sizeMode, szDecimals, maxSize });
		if (next !== null) writeSize(String(next));
	}

	function formatAvailableBalance(): string {
		if (!isActive) return FALLBACK_VALUE_PLACEHOLDER;
		const decimals = isSpotMarket && side === "sell" ? szDecimals : 2;
		return formatToken(availableBalance, decimals);
	}

	const change24h = get24hChange(market?.prevDayPx, market?.markPx);
	const priceColorClass = change24h !== null ? getValueColorClass(change24h) : "text-fg";

	// The shared submitOrderForm() helper (chart picks, Chase Close) drives a real
	// <form data-order-form> — wrap the mobile view in one so programmatic
	// submissions work here exactly like on the desktop panel.
	function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const el = event.currentTarget;
		const force = el.dataset.hlForceSubmit === "1";
		delete el.dataset.hlForceSubmit;
		// A submitter means the visible button's own onClick already ran this gesture.
		if ((event.nativeEvent as SubmitEvent).submitter) return;
		void handleSubmit(force);
	}

	return (
		<form data-order-form onSubmit={handleFormSubmit} className="contents">
			<div className={cn("flex flex-col h-full min-h-0 bg-background", className)}>
				<MarginModeModal
					open={showMarginDialog}
					onOpenChange={(open) => {
						if (!open) resetPendingLeverage();
						setShowMarginDialog(open);
					}}
					currentMode={marginMode}
					currentLeverage={currentLeverage}
					pendingLeverage={pendingLeverage}
					maxLeverage={maxLeverage}
					onPendingLeverageChange={setPendingLeverage}
					hasPosition={hasPosition}
					isOnlyIsolated={capabilities.isOnlyIsolated}
					isUpdating={isSwitchingMode}
					updateError={switchModeError}
					showLeverage={capabilities.isLeveraged}
					onApply={async (mode: MarginMode, lev: number) => applyMarginAndLeverage(mode, lev)}
				/>
				<div className="shrink-0 px-4 py-2 border-b border-stroke-weak/60 bg-surface">
					<div className="flex items-center justify-between">
						<TokenSelector selectedMarket={market} onValueChange={handleMarketChange} />
						<div className="text-right">
							<div className={cn("text-sm font-semibold tabular-nums", priceColorClass)}>
								{formatPrice(markPx || null, { szDecimals: market?.szDecimals })}
							</div>
							{typeof change24h === "number" && (
								<div className={cn("text-xs tabular-nums", getValueColorClass(change24h))}>
									{change24h >= 0 ? "+" : ""}
									{change24h.toFixed(2)}%
								</div>
							)}
						</div>
					</div>
				</div>
				<div className="flex-1 min-h-0 overflow-y-auto">
					<div className="px-3 py-4 space-y-4">
						<ModeSwitch />
						<TradeHeader
							orderType={orderType}
							side={side}
							sideLabels={sideLabels}
							marketKind={market?.kind}
							onOrderTypeChange={(type) =>
								setOrderType(
									type,
									type === "limit"
										? {
												price: toNumberOrZero(limitPriceInput) > 0 ? toNumberOrZero(limitPriceInput) : markPx,
												szDecimals,
											}
										: undefined,
								)
							}
							onSideChange={setSide}
							marginMode={marginMode}
							leverage={leverage}
							onMarginLeverageClick={() => setShowMarginDialog(true)}
							isLeveraged={capabilities.isLeveraged}
						/>

						<div className="flex items-center justify-end text-xs">
							<span className="text-fg-muted uppercase text-2xs font-medium">{ORDER_TEXT.AVAILABLE_LABEL} </span>
							<span className={cn("tabular-nums font-semibold text-xs ml-1", getValueColorClass(availableBalance))}>
								{formatAvailableBalance()}
							</span>
							<span className="ml-1 text-2xs tabular-nums text-fg-muted">{availableBalanceToken}</span>
						</div>

						<div className="space-y-3">
							<p className="text-2xs font-medium uppercase text-fg-muted">{ORDER_TEXT.SIZE_LABEL}</p>
							{/* The size box is in COIN units (what the exchange takes), so on a cheap
							    market a "$50" chip correctly shows hundreds of units. Without the dollar
							    equivalent that reads as a bug — so show it. */}
							<p className="-mt-2 text-2xs tabular-nums text-fg-muted">
								{orderValue > 0
									? `${formatUSD(orderValue)} ${quoteToken ?? ""}`.trim()
									: t`Enter size in ${sizeMode === "base" ? (baseToken ?? "coin") : (quoteToken ?? "USD")}`}
							</p>
							<div className="flex items-stretch gap-2">
								<NumberInput
									key={`size-${sizeClearNonce}`}
									inputMode="decimal"
									inputSize="xl"
									placeholder="0.00"
									value={sizeInput}
									onFocus={() => {
										// A deliberate focus clears the guard so typing the same number again works.
										staleSizeRef.current = null;
									}}
									onChange={(e: ChangeEvent<HTMLInputElement>) => {
										const next = e.target.value;
										if (staleSizeRef.current !== null && next === staleSizeRef.current) return;
										writeSize(next);
									}}
									className="flex-1 tabular-nums font-semibold"
									disabled={isFormDisabled}
								/>
								<Button
									variant="outline"
									intent="neutral"
									size="sm"
									onClick={handleSizeModeToggle}
									disabled={isFormDisabled}
									iconRight={<CaretDownIcon className="size-3.5" />}
									className="shrink-0 self-stretch"
								>
									{sizeMode === "base" ? baseToken || "\u2014" : quoteToken || "\u2014"}
								</Button>
							</div>
							{/* Quick-size chips: the pill is only 22px tall but a fingertip is ~40px. Without
							extra room a near-miss lands on the slider 12px below and jumps the size to
							whatever percent the finger lands on — the "it maxed out the position" bug. The
							transparent ::after grows the TAP target vertically only (so neighbouring
							chips can never overlap) without moving anything, and `touch-manipulation`
							stops the tap being read as the start of a scroll in this scrollable sheet. */}
							{!isSpotMarket && (
								<div className="flex flex-wrap items-center gap-1 mb-2 touch-manipulation">
									{sizeButtonAmounts.map((amount) => (
										<button
											key={`size-${amount}`}
											type="button"
											title={t`Add ${amount} USD to size`}
											aria-label={t`Add ${amount} USD to size`}
											disabled={isFormDisabled}
											onClick={() => handleAddSize(amount)}
											className="relative px-2 py-0.5 rounded-xs border border-stroke-weak bg-fill-hover text-2xs text-fg tabular-nums hover:bg-fill-hover/70 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-['']"
										>
											{`$${amount}`}
										</button>
									))}
									<button
										type="button"
										title={t`Clear size`}
										aria-label={t`Clear size`}
										disabled={isFormDisabled}
										onClick={() => {
											// Clear both: leaving the old size in the store makes it reappear the
											// next time this form mounts, which looks like a random size change.
											// ...and remember it, so the field cannot re-commit it right after.
											staleSizeRef.current = sizeInput;
											// ...and claim the field, so the store->field invariant does not re-adopt
											// the pre-clear value while the store update is still in flight.
											lastSizeWriteRef.current = "";
											setSizeInput("");
											setSize("");
											// …and remount, so the number field cannot re-commit the old value.
											setSizeClearNonce((nonce) => nonce + 1);
										}}
										className="relative ml-auto px-2 py-0.5 rounded-xs border border-stroke-weak bg-fill-hover text-2xs text-fg-muted hover:text-fg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-['']"
									>
										CC
									</button>
								</div>
							)}
							<div className="space-y-2">
								{/* Dead space above the slider so a chip miss falls here, not on a track that
									    would jump the size to max. */}
								<div className="h-1" aria-hidden="true" />
								<Slider
									thumbSize="lg"
									value={[sliderValue]}
									onValueChange={(v) => {
										const val = Array.isArray(v) ? v[0] : v;
										if (!isDraggingSlider) sliderEpochRef.current = sizeEpochRef.current;
										setIsDraggingSlider(true);
										setDragSliderValue(val);
									}}
									onValueCommitted={(value) => {
										const val = Array.isArray(value) ? value[0] : value;
										setIsDraggingSlider(false);
										// A commit that lands after the size was cleared, chipped or typed is stale —
										// applying it is what made "$50 after CC" add to the previous size.
										if (sliderEpochRef.current !== sizeEpochRef.current) return;
										applySizeFromPercent(val);
									}}
									max={100}
									step={0.1}
									disabled={isFormDisabled || maxSize <= 0}
								/>
								<div className="flex items-center justify-between text-2xs text-fg-muted tabular-nums leading-none py-2 -my-2 touch-manipulation">
									{SIZE_PERCENT_OPTIONS.map((pct) => (
										<button
											key={pct}
											type="button"
											onClick={() => applySizeFromPercent(pct)}
											disabled={isFormDisabled || maxSize <= 0}
											className="relative px-1 hover:text-fg transition-colors disabled:cursor-not-allowed after:absolute after:inset-x-0 after:-inset-y-3 after:content-['']"
										>
											{pct}%
										</button>
									))}
								</div>
							</div>
						</div>

						{usesLimitPrice && !isChase && (
							<PriceInput
								label={ORDER_TEXT.LIMIT_PRICE_LABEL}
								inputMode="decimal"
								inputSize="xl"
								placeholder="0.00"
								value={limitPriceInput}
								onChange={(e: ChangeEvent<HTMLInputElement>) => {
									const next = e.target.value;
									setLimitPriceInput(next);
									// Write through to the store: the canvas preview line (and
									// chart price picks) read the store, not this local field.
									setLimitPrice(next);
								}}
								onMidClick={setLimitPriceInput}
								midPrice={markPx}
								szDecimals={market?.szDecimals}
								className="tabular-nums font-semibold"
								disabled={isFormDisabled}
							/>
						)}

						{(capabilities.hasReduceOnly || (capabilities.hasTpSl && canUseTpSl)) && (
							<div className="flex items-center gap-4">
								{capabilities.hasReduceOnly && (
									<Checkbox
										checked={reduceOnly}
										onCheckedChange={(checked: boolean | "indeterminate") => setReduceOnly(checked === true)}
										disabled={isFormDisabled}
										label={ORDER_TEXT.REDUCE_ONLY_LABEL}
									/>
								)}
								{capabilities.hasTpSl && canUseTpSl && (
									<Checkbox
										checked={storeTpSlEnabled}
										onCheckedChange={(checked: boolean | "indeterminate") => {
											// Same as desktop: seed fresh ±2% off the reference price
											// (typed limit, else mark) so the fields and the canvas
											// previews show something sensible immediately.
											const enabled = checked === true;
											setTpSlEnabled(
												enabled,
												enabled
													? {
															base: price > 0 ? price : markPx,
															priceDecimals: szDecimalsToPriceDecimals(szDecimals),
														}
													: undefined,
											);
										}}
										disabled={isFormDisabled}
										label={ORDER_TEXT.TPSL_LABEL}
									/>
								)}
							</div>
						)}

						{scaleOrder && <TradeFormScale markPx={markPx} szDecimals={szDecimals} disabled={isFormDisabled} />}
						{twapOrder && <TradeFormTwap disabled={isFormDisabled} />}
						{showTif && <TradeFormTif orderType={orderType} disabled={isFormDisabled} />}
						{capabilities.hasTpSl && canUseTpSl && storeTpSlEnabled && (
							<TradeFormTpSl
								referencePrice={price > 0 ? price : markPx}
								size={sizeValue}
								szDecimals={szDecimals}
								disabled={isFormDisabled}
							/>
						)}
						<div className="divide-y divide-stroke-weak/40 text-xs">
							{capabilities.isLeveraged && (
								<SummaryRow
									label={ORDER_TEXT.SUMMARY_LIQ}
									value={
										liqPrice ? formatPrice(liqPrice, { szDecimals: market?.szDecimals }) : FALLBACK_VALUE_PLACEHOLDER
									}
									valueClass="text-error"
								/>
							)}
							<SummaryRow
								label={ORDER_TEXT.SUMMARY_ORDER_VALUE}
								value={orderValue > 0 ? formatUSD(orderValue) : FALLBACK_VALUE_PLACEHOLDER}
							/>
							{capabilities.isLeveraged && (
								<SummaryRow
									label={ORDER_TEXT.SUMMARY_MARGIN_REQ}
									value={marginRequired > 0 ? formatUSD(marginRequired) : FALLBACK_VALUE_PLACEHOLDER}
								/>
							)}
							<div className="flex items-center justify-between py-2.5">
								<span className="text-fg-muted">{ORDER_TEXT.SUMMARY_SLIPPAGE}</span>
								<button
									type="button"
									onClick={openSettingsDialog}
									className="inline-flex cursor-pointer items-center gap-1 hover:opacity-80"
								>
									<span className="tabular-nums text-error">{slippagePercent}%</span>
									<PencilIcon className="size-2.5 text-fg-muted" />
								</button>
							</div>
							<SummaryRow
								label={ORDER_TEXT.SUMMARY_FEE}
								value={orderValue > 0 ? `${feeRatePercent} (${formatUSD(estimatedFee)})` : feeRatePercent}
								valueClass="text-fg-muted"
							/>
						</div>
					</div>
				</div>

				<div className="shrink-0 px-3 py-3 border-t border-stroke-weak/40 bg-background">
					{validation.errors.length > 0 && isActive && availableBalance > 0 && !validation.needsApproval && (
						<p className="text-xs text-error mb-2">{validation.errors.join(" \u2022 ")}</p>
					)}
					{approvalError && <p className="text-xs text-error mb-2">{approvalError}</p>}
					<Button
						variant="outline"
						size="lg"
						onClick={buttonContent.action}
						disabled={buttonContent.disabled}
						intent={buttonContent.variant === "cyan" ? "brand" : buttonContent.variant === "buy" ? "neutral" : "error"}
						className={cn(
							"w-full",
							buttonContent.variant === "cyan"
								? "bg-brand-soft border-stroke-brand-strong text-brand hover:bg-brand-soft/30"
								: buttonContent.variant === "buy"
									? "bg-success-soft border-stroke-success-strong text-success hover:bg-success-soft/30"
									: "bg-error-soft border-stroke-error-strong text-error hover:bg-error-soft/30",
						)}
						iconLeft={isSubmitting || isRegistering ? <SpinnerGapIcon className="size-5 animate-spin" /> : undefined}
					>
						{buttonContent.text}
					</Button>
					<MobileBottomNavSpacer />
				</div>

				<WalletModal open={walletModalOpen} onOpenChange={setWalletModalOpen} />
				<OrderToast />
			</div>
		</form>
	);
}

function SummaryRow({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
	return (
		<div className="flex items-center justify-between py-2.5">
			<span className="text-fg-muted">{label}</span>
			<span className={cn("tabular-nums", valueClass ?? "text-fg")}>{value}</span>
		</div>
	);
}

interface MobileButtonContentInput {
	isConnected: boolean;
	needsChainSwitch: boolean;
	isSwitchingChain: boolean;
	availableBalance: number;
	needsApproval: boolean;
	/**
	 * Approving an agent needs a signing wallet. A phone running on a linked
	 * Phone Access key has none, so it must never be offered that action: it can
	 * only re-check the key's on-chain status (retry) or connect a wallet.
	 */
	canApproveOnDevice: boolean;
	onRecheckKey: () => void;
	canSubmit: boolean;
	isRegistering: boolean;
	canApprove: boolean;
	isSubmitting: boolean;
	side: Side;
	sideLabel: string;
	onConnect: () => void;
	onSwitchChain: () => void;
	onApprove: () => void;
	onSubmit: () => void;
}

function getMobileOrderButtonContent(input: MobileButtonContentInput): ButtonContent {
	if (!input.isConnected) {
		return {
			text: ORDER_TEXT.BUTTON_CONNECT,
			action: input.onConnect,
			disabled: false,
			variant: "cyan",
		};
	}
	if (input.needsChainSwitch) {
		return {
			text: input.isSwitchingChain ? ORDER_TEXT.BUTTON_SWITCHING : ORDER_TEXT.BUTTON_SWITCH_CHAIN,
			action: input.onSwitchChain,
			disabled: input.isSwitchingChain,
			variant: "cyan",
		};
	}
	if (input.needsApproval) {
		// No wallet here: an approval can never be signed, so offer a re-check of the
		// linked key's on-chain status instead of a dead button.
		if (!input.canApproveOnDevice) {
			return {
				text: input.isRegistering ? ORDER_TEXT.BUTTON_SIGNING : t`Check trading key`,
				action: input.onRecheckKey,
				disabled: input.isRegistering,
				variant: "cyan",
			};
		}
		return {
			text: getApprovalButtonText(input.isRegistering, input.canApprove),
			action: input.onApprove,
			disabled: input.isRegistering || !input.canApprove,
			variant: "cyan",
		};
	}
	return {
		text: input.sideLabel,
		action: input.onSubmit,
		disabled: !input.canSubmit || input.isSubmitting,
		variant: input.side,
	};
}

function getApprovalButtonText(isRegistering: boolean, canApprove: boolean): string {
	if (isRegistering) return ORDER_TEXT.BUTTON_SIGNING;
	if (!canApprove) return ORDER_TEXT.BUTTON_LOADING;
	return ORDER_TEXT.BUTTON_ENABLE_TRADING;
}

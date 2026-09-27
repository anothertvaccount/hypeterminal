import { Badge, Button, ButtonIcon } from "@hypeterminal/ui";
import { t } from "@lingui/core/macro";
import { CopyIcon, SignOutIcon, WalletIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { Skeleton } from "boneyard-js/react";
import { useMemo, useState } from "react";
import { useDisconnect } from "wagmi";
import { DEFAULT_QUOTE_TOKEN, FALLBACK_VALUE_PLACEHOLDER } from "@/config/app";
import { SMALL_BALANCE_THRESHOLD_USD } from "@/config/trade";
import { UI_TEXT } from "@/config/ui-text";
import {
	getSpotBalance,
	getSpotBalanceRows,
	getTotalUsdValue,
	isQuoteBalanceSharedWithPerps,
} from "@/domain/trade/balances";
import { useDefaultDexBalances } from "@/hooks/trade/use-account-balances";
import { useCopyToClipboard } from "@/hooks/ui/use-copy-to-clipboard";
import { cn } from "@/lib/cn";
import { formatPercent, formatUSD, shortenAddress } from "@/lib/format";
import { clearAgentSessionAddress, useAgentWalletActions, useHyperliquid, useTradingSession } from "@/lib/hyperliquid";
import { toNumberOrZero } from "@/lib/trade/numbers";
import { WalletModal } from "../components/wallet-modal";
import { NukeButton } from "../nuke-button";
import { MobileBottomNavSpacer } from "./mobile-bottom-nav";

const ACCOUNT_TEXT = UI_TEXT.ACCOUNT_PANEL;

interface MobileAccountViewProps {
	className?: string;
}

export function MobileAccountView({ className }: MobileAccountViewProps) {
	const navigate = useNavigate();
	// A linked Phone Access key trades an account with no wallet attached, so the
	// whole view keys off the trading session rather than wagmi's connection.
	const { address, isWallet, sessionOwner, isActive } = useTradingSession();
	const disconnect = useDisconnect();
	const { clearAgent } = useAgentWalletActions();
	// Same env the session pointer is keyed by — not a second, independently
	// derived one (those drift if the network is switched without a reload).
	const { env } = useHyperliquid();

	const {
		marginSummary,
		perpSummary,
		perpPositions,
		withdrawable,
		crossMaintenanceMarginUsed,
		spotBalances,
		spotAvailableAfterMaintenance,
		accountAbstraction,
		isLoading,
		perpError,
		spotError,
	} = useDefaultDexBalances();

	const [walletModalOpen, setWalletModalOpen] = useState(false);
	const { copied, copy } = useCopyToClipboard();

	function handleCopyAddress() {
		if (!address) return;
		copy(address);
	}

	/**
	 * Drop the linked key from this device. The on-chain agent stays approved
	 * until it expires (revoking it needs the owner's wallet, which this phone
	 * does not have) — but without the key and the session pointer nothing here
	 * can sign for the account any more.
	 */
	function handleForgetKey() {
		if (sessionOwner) clearAgent(env, sessionOwner);
		clearAgentSessionAddress(env);
	}

	const sharedQuoteWithPerps = isQuoteBalanceSharedWithPerps(accountAbstraction);

	let unrealizedPnl = 0;
	for (const pos of perpPositions) {
		unrealizedPnl += toNumberOrZero(pos.position.unrealizedPnl);
	}

	// Equity is the exchange's own perp account value — do NOT substitute the spot
	// quote balance for it on a unified account. Measured against a live unified
	// account: marginSummary reported $156.26M while spot USDC was $190.92M with
	// −$104.65M uPnL, i.e. the exchange figure is not the phantom it looks like,
	// and deriving equity from spot both ignores non-quote spot holdings ($61.5M
	// there) and disagrees with Hyperliquid's own `portfolio` endpoint. Changing
	// this needs the same measurement, not a hypothesis — see the handoff note.
	const accountValue = toNumberOrZero(marginSummary?.accountValue);
	const totalMarginUsed = toNumberOrZero(marginSummary?.totalMarginUsed);
	const crossAccountValue = toNumberOrZero(perpSummary?.accountValue);
	const crossNtlPos = toNumberOrZero(perpSummary?.totalNtlPos);
	const maintenanceMargin = toNumberOrZero(crossMaintenanceMarginUsed);
	const availableBalance = toNumberOrZero(withdrawable);
	const marginRatio = crossAccountValue > 0 ? maintenanceMargin / crossAccountValue : 0;
	const crossLeverage = crossAccountValue > 0 ? Math.abs(crossNtlPos) / crossAccountValue : 0;
	// `marginSummary.totalRawUsd` is a notional-like figure and reads absurdly high
	// next to equity ($958M vs $157M equity on a test account), so derive cash
	// instead: balance = equity − uPnL, the exchange's own definition and what the
	// paper branch and the desktop account panel use.
	const balance = accountValue - unrealizedPnl;

	// Spot holdings. `getSpotBalanceRows` deliberately omits the quote balance when
	// it is shared with perps (it would double-count against the perp rows), but on
	// a unified account that USDC is the user's real money and the reason they
	// "can't find" their balance — so surface it here, labelled as collateral.
	const spotRows = useMemo(
		() => getSpotBalanceRows(spotBalances, spotAvailableAfterMaintenance, accountAbstraction),
		[spotBalances, spotAvailableAfterMaintenance, accountAbstraction],
	);
	const sharedQuoteRow = useMemo(() => {
		if (!sharedQuoteWithPerps) return null;
		const quote = getSpotBalance(spotBalances, DEFAULT_QUOTE_TOKEN);
		return quote && toNumberOrZero(quote.total) > 0 ? quote : null;
	}, [sharedQuoteWithPerps, spotBalances]);
	const spotUsd = useMemo(() => getTotalUsdValue(spotRows), [spotRows]) + toNumberOrZero(sharedQuoteRow?.total);
	const hasSpotFunds = spotUsd >= SMALL_BALANCE_THRESHOLD_USD;
	// Only worth saying when the spot balance is real money, not dust.
	const showSpotOnlyHint = !sharedQuoteWithPerps && !perpError && !isLoading && accountValue === 0 && hasSpotFunds;

	// No wallet AND no linked key: nothing to show but the two ways in.
	if (!isActive) {
		return (
			<div className={cn("flex flex-col h-full min-h-0 bg-background", className)}>
				<div className="flex-1 flex flex-col items-center justify-center gap-6 p-6">
					<div className="size-20 rounded-full bg-surface flex items-center justify-center">
						<WalletIcon className="size-10 text-fg-muted" />
					</div>
					<div className="text-center space-y-2">
						<h2 className="text-lg font-semibold">{t`Connect Wallet`}</h2>
						<p className="text-sm text-fg-muted max-w-xs">
							{t`Connect your wallet to view your account, positions, and start trading.`}
						</p>
					</div>
					<div className="flex flex-col items-center gap-2">
						<Button variant="outline" intent="brand" size="md" onClick={() => setWalletModalOpen(true)}>
							{t`Connect Wallet`}
						</Button>
						<p className="text-2xs text-fg-muted">or</p>
						<Button
							variant="outline"
							intent="neutral"
							size="md"
							onClick={() => void navigate({ to: "/mobile-agent-sync" })}
						>
							{t`Use a key from my desktop`}
						</Button>
						<p className="max-w-xs text-center text-2xs text-fg-muted">
							{t`For hardware wallets: approve a trading key on your desktop, then link this phone.`}
						</p>
					</div>
				</div>
				<MobileBottomNavSpacer />
				<WalletModal open={walletModalOpen} onOpenChange={setWalletModalOpen} />
			</div>
		);
	}

	return (
		<div className={cn("flex flex-col h-full min-h-0 bg-background", className)}>
			<div className="shrink-0 px-4 py-4 border-b border-stroke-weak/60 bg-surface">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						<div className="size-10 rounded-full bg-brand-soft flex items-center justify-center">
							<span className="text-brand font-bold">{address?.slice(2, 4).toUpperCase()}</span>
						</div>
						<div>
							<div className="flex items-center gap-2">
								<span className="font-mono text-sm">
									{address?.slice(0, 6)}...{address?.slice(-4)}
								</span>
								<ButtonIcon
									variant="ghost"
									intent="neutral"
									size="sm"
									className="touch-target"
									onClick={handleCopyAddress}
									aria-label={t`Copy address`}
								>
									<CopyIcon className={cn("size-3.5", copied && "text-success")} />
								</ButtonIcon>
							</div>
							<div className="mt-0.5 flex items-center gap-1.5">
								<Badge tone="neutral" size="sm">
									{t`Cross Margin`}
								</Badge>
								{/* Say plainly that this is a key, not a wallet: the account can
								    trade but can never withdraw from this device. */}
								{!isWallet && (
									<Badge tone="success" size="sm">
										{t`Trading key`}
									</Badge>
								)}
							</div>
						</div>
					</div>
					{isWallet && (
						<ButtonIcon
							variant="ghost"
							intent="error"
							size="md"
							className="touch-target"
							onClick={() => disconnect.mutate()}
							aria-label={t`Disconnect wallet`}
						>
							<SignOutIcon className="size-5" />
						</ButtonIcon>
					)}
				</div>
			</div>

			<div className="flex-1 min-h-0 overflow-y-auto">
				<div className="p-2 space-y-4">
					{perpError && (
						// A failed subscription must not masquerade as a real $0.00 account.
						<div className="rounded-xs border border-stroke-error-strong/30 bg-error-soft/20 p-3">
							<p className="text-2xs font-medium text-error">{t`Couldn't load this account`}</p>
							<p className="mt-1 text-2xs text-fg-muted">
								{t`The exchange feed didn't answer — the figures below may be wrong. Pull to refresh or reopen the app.`}
							</p>
						</div>
					)}
					{showSpotOnlyHint && (
						<div className="rounded-xs border border-stroke-warning-strong/30 bg-warning-soft/20 p-3">
							<p className="text-2xs font-medium text-warning">{t`Your funds are in spot`}</p>
							<p className="mt-1 text-2xs text-fg-muted">
								{t`Perp equity is $0.00 because your funds are in spot. Move them to perps from your desktop — a trading key can only trade, not move funds.`}
							</p>
						</div>
					)}
					{/* On a classic account spot and perps are separate pots: a deposit
					    lands in spot and only what was moved to perps is equity, so label
					    it perps and show spot beside it. On a unified account the spot
					    quote balance IS the collateral, so the headline is the whole
					    account and there is no separate spot row. */}
					{sharedQuoteWithPerps && (
						<div className="rounded-xs border border-stroke-weak/60 bg-fill-weak p-3">
							<p className="text-2xs text-fg-muted">
								{t`Unified account: your spot USDC collateralises perps, so it does not all appear as perp equity.`}
							</p>
						</div>
					)}
					<div className="p-4 rounded-xs border border-stroke-weak/60 bg-surface">
						<Skeleton name="account-equity" loading={isLoading}>
							{/* This figure is the exchange's perp account value, so name it that
							    in both cases; the body around it explains where spot money is. */}
							<div className="text-2xs uppercase font-medium text-fg-muted mb-1.5">{t`Perps equity`}</div>
							<div className="text-3xl font-bold tabular-nums text-fg">
								{perpError ? FALLBACK_VALUE_PLACEHOLDER : formatUSD(accountValue)}
							</div>
							<div
								className={cn(
									"text-sm tabular-nums mt-1.5 font-medium",
									unrealizedPnl >= 0 ? "text-success" : "text-error",
								)}
							>
								{unrealizedPnl >= 0 ? "+" : ""}
								{formatUSD(unrealizedPnl)} {ACCOUNT_TEXT.UNREALIZED_LABEL}
							</div>
						</Skeleton>
					</div>

					<div className="grid grid-cols-2 gap-3">
						{hasSpotFunds && (
							<StatCard
								label={sharedQuoteWithPerps ? t`Spot (collateral)` : t`Spot`}
								value={spotError ? FALLBACK_VALUE_PLACEHOLDER : formatUSD(spotUsd)}
								isLoading={isLoading}
							/>
						)}
						<StatCard
							label={ACCOUNT_TEXT.BALANCE_LABEL}
							value={perpError ? FALLBACK_VALUE_PLACEHOLDER : formatUSD(balance)}
							isLoading={isLoading}
						/>
						<StatCard label={ACCOUNT_TEXT.AVAILABLE_LABEL} value={formatUSD(availableBalance)} isLoading={isLoading} />
						<StatCard label={ACCOUNT_TEXT.MARGIN_USED_LABEL} value={formatUSD(totalMarginUsed)} isLoading={isLoading} />
						<StatCard
							label={ACCOUNT_TEXT.MARGIN_RATIO_LABEL}
							value={formatPercent(marginRatio)}
							valueClass={marginRatio > 0.8 ? "text-error" : marginRatio > 0.5 ? "text-warning" : ""}
							isLoading={isLoading}
						/>
						<StatCard label={t`Maintenance Margin`} value={formatUSD(maintenanceMargin)} isLoading={isLoading} />
						<StatCard
							label={ACCOUNT_TEXT.CROSS_LEVERAGE_LABEL}
							value={`${crossLeverage.toFixed(2)}x`}
							isLoading={isLoading}
						/>
					</div>
				</div>
			</div>

			<div className="px-2 pb-2 space-y-2">
				{/* Two ways to trade from the phone: WalletConnect (the wallet button
				    above) or a trading agent approved on your desktop — pick either.
				    The agent flow is the one for hardware-wallet accounts, since it
				    never needs a wallet (or the device) on this phone. */}
				<div className="rounded-xs border border-stroke-weak/60 bg-surface p-3 space-y-2">
					<div>
						<div className="text-2xs uppercase font-medium text-fg-muted mb-0.5">{t`Phone access`}</div>
						{sessionOwner ? (
							<p className="text-2xs text-fg-muted">
								{t`Trading ${shortenAddress(sessionOwner)} with a key approved on your desktop. This key cannot withdraw.`}
							</p>
						) : (
							<p className="text-2xs text-fg-muted">
								{t`Use a trading key approved on your desktop — no wallet or hardware needed here.`}
							</p>
						)}
					</div>
					{sessionOwner ? (
						<Button
							type="button"
							variant="outline"
							intent="neutral"
							size="sm"
							className="w-full"
							onClick={handleForgetKey}
						>
							{t`Forget this key`}
						</Button>
					) : (
						<Button
							type="button"
							variant="outline"
							intent="neutral"
							size="sm"
							className="w-full"
							onClick={() => void navigate({ to: "/mobile-agent-sync" })}
						>
							{t`Link a desktop device`}
						</Button>
					)}
				</div>
				<div className="rounded-xs border border-stroke-error-strong/25 bg-error-soft/20 p-3 space-y-2">
					<div>
						<div className="text-2xs uppercase font-medium text-error mb-0.5">{t`Close everything`}</div>
						<p className="text-2xs text-fg-muted">
							{t`Cancel every resting order and market-close every position on this account.`}
						</p>
					</div>
					<NukeButton label={t`Close everything`} />
				</div>
			</div>

			<MobileBottomNavSpacer />
		</div>
	);
}

interface StatCardProps {
	label: string;
	value: string;
	valueClass?: string;
	isLoading?: boolean;
}

function StatCard({ label, value, valueClass, isLoading }: StatCardProps) {
	return (
		<div className="p-3 rounded-xs border border-stroke-weak/40 bg-surface">
			<div className="text-2xs text-fg-muted mb-1">{label}</div>
			<Skeleton name="stat-card-value" loading={isLoading ?? false}>
				<div className={cn("text-base font-semibold tabular-nums", valueClass)}>{value}</div>
			</Skeleton>
		</div>
	);
}

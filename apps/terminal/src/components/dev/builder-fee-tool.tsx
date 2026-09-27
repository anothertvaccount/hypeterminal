import { useCallback, useEffect, useState } from "react";
import { useConnect, useConnection } from "wagmi";
import { bpsToPercentage, shortenAddress } from "@/lib/format";
import { getInfoClient, useExchange } from "@/lib/hyperliquid";
import { getNetwork } from "@/lib/network";

/**
 * Dev-only tool (route /dev-builder-fees): shows which builders your wallet has
 * approved a maximum fee for, and overwrites each cap to 0% via the exchange's
 * `approveBuilderFee` action (one wallet signature per row). It never trades,
 * transfers, or moves funds — the signed action only updates your fee allowance.
 */

interface ApprovalRow {
	builder: `0x${string}`;
	maxFee: number;
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export function BuilderFeeTool() {
	if (!import.meta.env.DEV) {
		return (
			<div className="min-h-screen flex items-center justify-center px-6 text-sm text-fg-muted">
				This developer tool is only available in dev builds.
			</div>
		);
	}
	return <BuilderFeeToolInner />;
}

function BuilderFeeToolInner() {
	const { address, isConnected } = useConnection();
	const { connect, connectors } = useConnect();
	const { mutateAsync: approveBuilderFee, isPending: isApproving } = useExchange("approveBuilderFee");

	const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
	const [loading, setLoading] = useState(false);
	const [busyBuilder, setBusyBuilder] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (!address) {
			setApprovals([]);
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const info = getInfoClient();
			const builders = await info.approvedBuilders({ user: address });
			const rows = await Promise.all(
				builders.map(async (builder) => ({
					builder,
					maxFee: await info.maxBuilderFee({ user: address, builder }),
				})),
			);
			setApprovals(rows);
		} catch (loadError) {
			setError(describeError(loadError));
		} finally {
			setLoading(false);
		}
	}, [address]);

	useEffect(() => {
		void load();
	}, [load]);

	async function setMaxFeeToZero(builder: `0x${string}`) {
		if (!address) return;
		setError(null);
		setBusyBuilder(builder);
		try {
			// Same user-signed action hl-react uses during agent registration; only the
			// approved cap changes.
			await approveBuilderFee({ builder, maxFeeRate: "0%" });
			const maxFee = await getInfoClient().maxBuilderFee({ user: address, builder });
			setApprovals((previous) =>
				previous.map((row) => (row.builder.toLowerCase() === builder.toLowerCase() ? { ...row, maxFee } : row)),
			);
		} catch (zeroError) {
			setError(describeError(zeroError));
		} finally {
			setBusyBuilder(null);
		}
	}

	async function zeroAll() {
		for (const row of approvals) {
			if (row.maxFee > 0) await setMaxFeeToZero(row.builder);
		}
	}

	const busy = isApproving || busyBuilder !== null;
	const remaining = approvals.filter((row) => row.maxFee > 0);
	const mockConnector = connectors.find((connector) => connector.name.toLowerCase().includes("mock"));
	const browserConnector = connectors.find((connector) => connector.type === "injected");

	return (
		<div className="min-h-screen bg-background text-fg">
			<div className="max-w-xl mx-auto px-6 py-10 space-y-5">
				<div>
					<h1 className="text-lg font-semibold">Builder fee approvals</h1>
					<p className="text-sm text-fg-muted mt-1">
						Network: <span className="text-fg">{getNetwork()}</span> — your wallet may have granted builders permission
						to charge a fee on the trades they route. This page lists those grants and overwrites their cap to 0%. It
						only signs an approval update: no trades, no transfers, no funds move.
					</p>
				</div>

				{!isConnected || !address ? (
					<div className="border border-stroke-weak rounded-xs bg-surface p-4 space-y-3">
						<p className="text-sm text-fg-muted">Connect a wallet to list its approvals.</p>
						<div className="flex flex-wrap gap-2">
							{mockConnector && (
								<button
									type="button"
									className="px-3 py-1.5 rounded-xs border border-stroke-warning-strong/40 bg-warning-soft text-warning text-xs font-semibold"
									onClick={() => connect({ connector: mockConnector })}
								>
									Connect Mock Wallet
								</button>
							)}
							{browserConnector && (
								<button
									type="button"
									className="px-3 py-1.5 rounded-xs border border-stroke-weak bg-fill-hover text-fg text-xs font-semibold"
									onClick={() => connect({ connector: browserConnector })}
								>
									Connect Browser Wallet
								</button>
							)}
						</div>
					</div>
				) : (
					<>
						<div className="flex items-center justify-between gap-3">
							<span className="text-xs text-fg-muted">Connected: {shortenAddress(address, 6, 4)}</span>
							<div className="flex gap-2">
								<button
									type="button"
									disabled={busy || loading}
									className="px-3 py-1.5 rounded-xs border border-stroke-weak bg-fill-hover text-xs font-semibold disabled:opacity-50"
									onClick={() => void load()}
								>
									Refresh
								</button>
								<button
									type="button"
									disabled={busy || loading || remaining.length === 0}
									className="px-3 py-1.5 rounded-xs border border-stroke-warning-strong/40 bg-warning-soft text-warning text-xs font-semibold disabled:opacity-50"
									onClick={() => void zeroAll()}
								>
									Zero all ({remaining.length})
								</button>
							</div>
						</div>

						{error && <p className="text-xs text-error border border-error/30 rounded-xs p-2">{error}</p>}

						{loading ? (
							<p className="text-sm text-fg-muted">Loading approvals…</p>
						) : approvals.length === 0 ? (
							<p className="text-sm text-fg-muted border border-stroke-weak rounded-xs bg-surface p-4">
								No builders approved for this address — nothing can charge a builder fee on its trades.
							</p>
						) : (
							<ul className="border border-stroke-weak rounded-xs bg-surface divide-y divide-stroke-weak">
								{approvals.map((row) => {
									const isZero = row.maxFee === 0;
									return (
										<li key={row.builder} className="flex items-center justify-between gap-3 p-3">
											<div className="min-w-0">
												<p className="text-sm font-mono truncate" title={row.builder}>
													{shortenAddress(row.builder, 8, 6)}
												</p>
												<p className={`text-xs ${isZero ? "text-success" : "text-warning"}`}>
													Max fee {bpsToPercentage(row.maxFee)}% {isZero && "— revoked"}
												</p>
											</div>
											<button
												type="button"
												disabled={busy || isZero}
												className="shrink-0 px-3 py-1.5 rounded-xs border border-stroke-weak bg-fill-hover text-xs font-semibold disabled:opacity-40"
												onClick={() => void setMaxFeeToZero(row.builder)}
											>
												{busyBuilder === row.builder ? "Signing…" : "Set to 0%"}
											</button>
										</li>
									);
								})}
							</ul>
						)}
					</>
				)}

				<p className="text-xs text-fg-muted">
					After zeroing, a builder can either charge nothing or ask you to approve a new cap — decline to stay at 0%.
					Orders signed by other frontends are unaffected either way; the fee only exists on orders that carry the
					builder&apos;s code.
				</p>
			</div>
		</div>
	);
}

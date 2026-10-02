import {
	createMobileAgentApproval,
	createMobileAgentRevocationApproval,
	isStoredMobileAgent,
} from "@hypeterminal/hl-react/signing/mobile-agent";
import {
	AdaptiveModal,
	Button,
	ModalContent,
	ModalDescription,
	ModalFooter,
	ModalHeader,
	ModalTitle,
} from "@hypeterminal/ui";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	CaretDownIcon,
	CheckIcon,
	CopyIcon,
	DeviceMobileIcon,
	GithubLogoIcon,
	KeyIcon,
	QrCodeIcon,
	ShieldCheckIcon,
	SpinnerGapIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useConnection } from "wagmi";
import { GITHUB_URL } from "@/config/app";
import { PAPER_TRADE } from "@/config/paper";
import { useCopyToClipboard } from "@/hooks/ui/use-copy-to-clipboard";
import { cn } from "@/lib/cn";
import { shortenAddress } from "@/lib/format";
import { useAgentWalletActions, useAgentWalletStorage, useExchange, useHyperliquid } from "@/lib/hyperliquid";
import { createMobileAgentSyncUrl } from "@/lib/mobile-sync/sync-core";

interface MobileAgentSyncModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

type SyncState =
	| { status: "idle" }
	| { status: "approving" }
	| { status: "creating" }
	| {
			status: "ready";
			url: string;
			pairingCode: string;
			agentAddress: string;
			expiresAtMs: number;
			agentValidUntilMs: number;
	  }
	| { status: "link-expired"; agentAddress: string; agentValidUntilMs: number }
	| { status: "error"; message: string };

type ResetState =
	| { status: "idle" }
	| { status: "resetting" }
	| { status: "success"; agentAddress: string; expiresAtMs: number }
	| { status: "error"; message: string };

export function MobileAgentSyncModal({ open, onOpenChange }: MobileAgentSyncModalProps) {
	const { address } = useConnection();
	const { env } = useHyperliquid();
	const localAgent = useAgentWalletStorage(env, address);
	const { clearAgent } = useAgentWalletActions();
	const approveAgent = useExchange("approveAgent");
	const { copied: copiedPhoneLink, copy: copyPhoneLink } = useCopyToClipboard(1500);
	const { copied: copiedPairingCode, copy: copyPairingCode } = useCopyToClipboard(1500);
	const [syncState, setSyncState] = useState<SyncState>({ status: "idle" });
	const [resetState, setResetState] = useState<ResetState>({ status: "idle" });
	const [showQr, setShowQr] = useState(false);
	const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
	const [qrError, setQrError] = useState<string | null>(null);

	const readyUrl = syncState.status === "ready" ? syncState.url : null;

	useEffect(() => {
		if (syncState.status !== "ready") return;
		const delay = syncState.expiresAtMs - Date.now();
		if (delay <= 0) {
			setSyncState({
				status: "link-expired",
				agentAddress: syncState.agentAddress,
				agentValidUntilMs: syncState.agentValidUntilMs,
			});
			return;
		}
		const timer = setTimeout(() => {
			setSyncState((prev) => {
				if (prev.status !== "ready") return prev;
				return { status: "link-expired", agentAddress: prev.agentAddress, agentValidUntilMs: prev.agentValidUntilMs };
			});
		}, delay);
		return () => clearTimeout(timer);
	}, [syncState]);

	useEffect(() => {
		if (!showQr || !readyUrl) {
			setQrDataUrl(null);
			setQrError(null);
			return;
		}

		let cancelled = false;
		const qrText = readyUrl;
		setQrDataUrl(null);
		setQrError(null);

		async function renderQr() {
			try {
				const QRCode = await import("qrcode");
				const dataUrl = await QRCode.toDataURL(qrText, {
					errorCorrectionLevel: "M",
					margin: 1,
					width: 224,
					color: {
						dark: "#111827",
						light: "#FFFFFF",
					},
				});
				if (!cancelled) setQrDataUrl(dataUrl);
			} catch {
				if (!cancelled) setQrError(t`Could not render QR`);
			}
		}

		renderQr();

		return () => {
			cancelled = true;
		};
	}, [readyUrl, showQr]);

	const primaryButtonLabel = getPrimaryButtonLabel(syncState.status);

	function resetSyncState() {
		setSyncState({ status: "idle" });
		setResetState({ status: "idle" });
		setShowQr(false);
		setQrDataUrl(null);
		setQrError(null);
	}

	function handleOpenChange(nextOpen: boolean) {
		if (!nextOpen) resetSyncState();
		onOpenChange(nextOpen);
	}

	async function handleCreateSync() {
		if (!address) {
			setSyncState({ status: "error", message: t`Connect your wallet before linking a mobile device.` });
			return;
		}

		const approval = createMobileAgentApproval();
		resetSyncState();
		setSyncState({ status: "approving" });

		try {
			// Preview mode never signs: the phone trades with simulated funds anyway,
			// so skip the on-chain agent approval (mirrors useAgentStatus in paper).
			if (!PAPER_TRADE) {
				await approveAgent.mutateAsync({
					agentAddress: approval.publicKey,
					agentName: approval.agentName,
				});
			}
			setSyncState({ status: "creating" });

			const syncCreatedAtMs = Date.now();
			const syncUrl = await createMobileAgentSyncUrl({
				appOrigin: window.location.origin,
				// Follow vite's base so the link lands on the app under subpath deploys
				// (https://host/terminal/mobile-agent-sync) and at the root otherwise.
				routePath: `${import.meta.env.BASE_URL}mobile-agent-sync`,
				preview: PAPER_TRADE,
				env,
				userAddress: address,
				agentPrivateKey: approval.privateKey,
				agentName: approval.agentName,
				agentValidUntilMs: approval.agentValidUntilMs,
				nowMs: syncCreatedAtMs,
			});

			setSyncState({
				status: "ready",
				url: syncUrl.url,
				pairingCode: syncUrl.pairingCode,
				agentAddress: syncUrl.agentAddress,
				expiresAtMs: syncUrl.expiresAtMs,
				agentValidUntilMs: syncUrl.agentValidUntilMs,
			});
		} catch (error) {
			setSyncState({
				status: "error",
				message: error instanceof Error ? error.message : t`Could not link mobile device.`,
			});
		}
	}

	async function handleResetMobileAccess() {
		if (!address) {
			setResetState({ status: "error", message: t`Connect your wallet before resetting mobile access.` });
			return;
		}

		const revocation = createMobileAgentRevocationApproval();
		setResetState({ status: "resetting" });

		try {
			// Preview mode never signs (see handleCreateSync) — clearing the local
			// agent state is all a "reset" can mean without a wallet signature.
			if (!PAPER_TRADE) {
				await approveAgent.mutateAsync({
					agentAddress: revocation.publicKey,
					agentName: revocation.agentName,
				});
			}
			if (isStoredMobileAgent(localAgent)) {
				clearAgent(env, address);
			}
			setResetState({
				status: "success",
				agentAddress: revocation.publicKey,
				expiresAtMs: revocation.agentValidUntilMs,
			});
			setSyncState({ status: "idle" });
			setShowQr(false);
			setQrDataUrl(null);
		} catch (error) {
			setResetState({
				status: "error",
				message: error instanceof Error ? error.message : t`Could not reset mobile access.`,
			});
		}
	}

	// A link created on localhost points a phone at THIS machine — unreachable
	// from any other device. Say so instead of letting the QR look broken.
	const isLocalHost =
		typeof window !== "undefined" &&
		(window.location.hostname === "localhost" ||
			window.location.hostname === "127.0.0.1" ||
			window.location.hostname === "[::1]");
	const isPending = syncState.status === "approving" || syncState.status === "creating";
	const isReady = syncState.status === "ready";
	const isLinkExpired = syncState.status === "link-expired";
	const isResetting = resetState.status === "resetting";

	return (
		<AdaptiveModal open={open} onOpenChange={handleOpenChange} size="md" className="max-h-[min(92dvh,46rem)]">
			<ModalHeader>
				<div className="flex items-center gap-2">
					<DeviceMobileIcon className="size-4 text-brand" weight="duotone" aria-hidden />
					<ModalTitle>
						<Trans>Link mobile device</Trans>
					</ModalTitle>
				</div>
				<ModalDescription>
					<Trans>Create secure phone access for trading from this account.</Trans>
				</ModalDescription>
			</ModalHeader>

			<ModalContent className="space-y-4">
				<div className="flex items-center justify-between gap-3 rounded-8 border border-stroke-weak bg-fill-weak px-3 py-2 text-xs">
					<span className="text-fg-muted">
						<Trans>Using</Trans>
					</span>
					<span className="min-w-0 truncate font-medium text-fg">
						{address ? (
							<>
								<span className="font-mono">{shortenAddress(address)}</span>
								<span className="text-fg-muted"> · {env}</span>
							</>
						) : (
							<Trans>Wallet not connected</Trans>
						)}
					</span>
				</div>

				{syncState.status === "error" && (
					<div
						role="alert"
						className="flex items-start gap-2 rounded-8 border border-stroke-error-strong/25 bg-error-soft p-3 text-xs text-error"
					>
						<WarningCircleIcon className="mt-0.5 size-4 shrink-0" weight="fill" aria-hidden />
						<p>{syncState.message}</p>
					</div>
				)}

				{isLocalHost && (
					<div className="flex items-start gap-2 rounded-8 border border-stroke-warning-strong/25 bg-warning-soft p-3 text-xs">
						<WarningCircleIcon className="mt-0.5 size-4 shrink-0 text-warning" weight="fill" aria-hidden />
						<p className="text-warning">
							<Trans>
								You're running on localhost — a phone cannot reach this address. Open the deployed site in your browser
								first, then create the phone link there.
							</Trans>
						</p>
					</div>
				)}

				{!isReady && !isLinkExpired && (
					<div className="rounded-8 border border-stroke-weak bg-fill-weak p-3">
						<div className="flex items-start gap-3">
							<ShieldCheckIcon className="mt-0.5 size-5 shrink-0 text-brand" weight="duotone" aria-hidden />
							<div className="min-w-0 space-y-1">
								<p className="text-sm font-semibold text-fg">
									<Trans>Create phone access</Trans>
								</p>
								<p className="text-xs text-fg-muted">
									<Trans>Your wallet approves one trading key for this phone. It cannot withdraw funds.</Trans>
								</p>
							</div>
						</div>
					</div>
				)}

				{isReady && (
					<ReadySyncPanel
						state={syncState}
						copiedPhoneLink={copiedPhoneLink}
						copiedPairingCode={copiedPairingCode}
						showQr={showQr}
						qrDataUrl={qrDataUrl}
						qrError={qrError}
						onCopyPhoneLink={() => copyPhoneLink(syncState.url)}
						onCopyPairingCode={() => copyPairingCode(syncState.pairingCode)}
						onReveal={() => setShowQr(true)}
					/>
				)}

				{isLinkExpired && (
					<ExpiredLinkPanel state={syncState} onCreateNew={handleCreateSync} disabled={isPending || !address} />
				)}

				<ResetMobileAccessPanel
					state={resetState}
					disabled={isPending || isResetting || !address}
					onReset={handleResetMobileAccess}
				/>
			</ModalContent>

			{!isReady && !isLinkExpired && (
				<ModalFooter className="border-t border-stroke-weak">
					<Button
						type="button"
						variant="filled"
						intent="brand"
						size="sm"
						onClick={handleCreateSync}
						disabled={isPending || !address}
						iconLeft={
							isPending ? (
								<SpinnerGapIcon className="size-3.5 animate-spin" />
							) : (
								<DeviceMobileIcon className="size-3.5" />
							)
						}
					>
						{primaryButtonLabel}
					</Button>
				</ModalFooter>
			)}
		</AdaptiveModal>
	);
}

function getPrimaryButtonLabel(status: SyncState["status"]): string {
	if (status === "approving") return t`Approve in wallet...`;
	if (status === "creating") return t`Creating link...`;
	if (status === "error") return t`Try again`;
	return t`Create phone link`;
}

function ReadySyncPanel({
	state,
	copiedPhoneLink,
	copiedPairingCode,
	showQr,
	qrDataUrl,
	qrError,
	onCopyPhoneLink,
	onCopyPairingCode,
	onReveal,
}: {
	state: Extract<SyncState, { status: "ready" }>;
	copiedPhoneLink: boolean;
	copiedPairingCode: boolean;
	showQr: boolean;
	qrDataUrl: string | null;
	qrError: string | null;
	onCopyPhoneLink: () => void;
	onCopyPairingCode: () => void;
	onReveal: () => void;
}) {
	const linkExpiresLabel = new Date(state.expiresAtMs).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
	const agentExpiresLabel = new Date(state.agentValidUntilMs).toLocaleDateString([], {
		month: "short",
		day: "numeric",
	});

	return (
		<div className="space-y-3">
			<div className="flex items-start gap-2 rounded-8 border border-stroke-brand-strong/25 bg-fill-weak p-3">
				<CheckIcon className="mt-0.5 size-4 shrink-0 text-success" weight="bold" aria-hidden />
				<div className="min-w-0">
					<p className="text-sm font-semibold text-fg">
						<Trans>Phone link ready</Trans>
					</p>
					<p className="mt-0.5 truncate text-xs text-fg-muted">
						<Trans>Trading key approved until {agentExpiresLabel}</Trans>
					</p>
				</div>
			</div>
			<LinkSecurityExplainer agentExpiresLabel={agentExpiresLabel} />

			<div className="rounded-8 border border-stroke-weak bg-fill-weak p-3">
				<div className="flex items-center justify-between gap-3">
					<div className="flex min-w-0 items-center gap-2">
						<KeyIcon className="size-4 shrink-0 text-icon" aria-hidden />
						<p className="truncate text-xs font-semibold text-fg-muted">
							<Trans>Pairing code</Trans>
						</p>
					</div>
					<Button
						type="button"
						variant="outline"
						intent="neutral"
						size="sm"
						onClick={onCopyPairingCode}
						iconLeft={copiedPairingCode ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
						className="shrink-0"
					>
						{copiedPairingCode ? <Trans>Copied</Trans> : <Trans>Copy code</Trans>}
					</Button>
				</div>
				<p className="mt-2 select-all rounded-8 border border-stroke-weak bg-background px-3 py-2 text-center font-mono text-base font-semibold tracking-[0.12em] text-fg">
					{state.pairingCode}
				</p>
			</div>

			<div className="rounded-8 border border-stroke-weak bg-fill-weak p-3">
				<div className="flex items-center justify-between gap-3">
					<div className="min-w-0">
						<p className="text-sm font-semibold text-fg">
							<Trans>Scan on your phone</Trans>
						</p>
						<p className="mt-0.5 text-xs text-fg-muted">
							<Trans>Phone link expires {linkExpiresLabel}</Trans>
						</p>
					</div>
				</div>

				<p className="mt-2 break-all rounded-xs bg-fill-weak px-2 py-1.5 font-mono text-2xs text-fg-muted select-all">
					{state.url}
				</p>

				{showQr && (
					<div className="mt-3 flex justify-center rounded-8 border border-stroke-weak bg-white p-3">
						{qrDataUrl ? (
							<img src={qrDataUrl} alt={t`Phone link QR`} className="size-56 max-w-full" />
						) : qrError ? (
							<div className="flex h-56 w-56 items-center justify-center text-center text-xs font-semibold text-error">
								{qrError}
							</div>
						) : (
							<div className="flex h-56 w-56 items-center justify-center">
								<SpinnerGapIcon className="size-5 animate-spin text-brand" aria-hidden />
							</div>
						)}
					</div>
				)}
			</div>

			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
				<Button
					type="button"
					variant="outline"
					intent="neutral"
					size="sm"
					onClick={onCopyPhoneLink}
					iconLeft={copiedPhoneLink ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
					className="w-full"
				>
					{copiedPhoneLink ? <Trans>Copied</Trans> : <Trans>Copy phone link</Trans>}
				</Button>
				<Button
					type="button"
					variant="outline"
					intent="neutral"
					size="sm"
					onClick={onReveal}
					iconLeft={<QrCodeIcon className="size-3.5" />}
					className="w-full"
				>
					{showQr ? <Trans>QR visible</Trans> : <Trans>Show QR</Trans>}
				</Button>
			</div>
		</div>
	);
}

function ExpiredLinkPanel({
	state,
	onCreateNew,
	disabled,
}: {
	state: Extract<SyncState, { status: "link-expired" }>;
	onCreateNew: () => void;
	disabled: boolean;
}) {
	const agentExpiresLabel = new Date(state.agentValidUntilMs).toLocaleDateString([], {
		month: "short",
		day: "numeric",
	});

	return (
		<div className="space-y-3">
			<div className="flex items-start gap-2 rounded-8 border border-stroke-error-strong/25 bg-error-soft p-3">
				<WarningCircleIcon className="mt-0.5 size-4 shrink-0 text-error" weight="fill" aria-hidden />
				<div className="min-w-0">
					<p className="text-sm font-semibold text-fg">
						<Trans>Phone link expired</Trans>
					</p>
					<p className="mt-0.5 text-xs text-fg-muted">
						<Trans>
							Trading key still approved until {agentExpiresLabel}. Create a new link to import on your phone.
						</Trans>
					</p>
				</div>
			</div>
			<Button
				type="button"
				variant="filled"
				intent="brand"
				size="sm"
				onClick={onCreateNew}
				disabled={disabled}
				iconLeft={<DeviceMobileIcon className="size-3.5" />}
				className="w-full"
			>
				<Trans>Create new phone link</Trans>
			</Button>
		</div>
	);
}

function ResetMobileAccessPanel({
	state,
	disabled,
	onReset,
}: {
	state: ResetState;
	disabled: boolean;
	onReset: () => void;
}) {
	const expiresAtLabel =
		state.status === "success"
			? new Date(state.expiresAtMs).toLocaleTimeString([], {
					hour: "2-digit",
					minute: "2-digit",
				})
			: null;

	return (
		<div className="rounded-8 border border-stroke-weak bg-fill-weak p-3">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 space-y-1">
					<p className="text-sm font-semibold text-fg">
						<Trans>Reset phone access</Trans>
					</p>
					<p className="text-xs text-fg-muted">
						<Trans>Replaces the current phone key. The old phone must link again.</Trans>
					</p>
				</div>
				<Button
					type="button"
					variant="outline"
					intent="error"
					size="sm"
					disabled={disabled}
					onClick={onReset}
					iconLeft={
						state.status === "resetting" ? (
							<SpinnerGapIcon className="size-3.5 animate-spin" />
						) : (
							<WarningCircleIcon className="size-3.5" />
						)
					}
				>
					{state.status === "resetting" ? <Trans>Resetting...</Trans> : <Trans>Reset</Trans>}
				</Button>
			</div>
			{state.status === "success" && (
				<div className="mt-3 flex items-start gap-2 rounded-8 border border-stroke-brand-strong/25 bg-background p-2.5 text-xs text-fg-muted">
					<CheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" weight="bold" aria-hidden />
					<p>
						<Trans>Phone access reset. The replacement key expires at {expiresAtLabel}.</Trans>
					</p>
				</div>
			)}
			{state.status === "error" && (
				<div
					role="alert"
					className="mt-3 flex items-start gap-2 rounded-8 border border-stroke-error-strong/25 bg-error-soft p-2.5 text-xs text-error"
				>
					<WarningCircleIcon className="mt-0.5 size-3.5 shrink-0" weight="fill" aria-hidden />
					<p>{state.message}</p>
				</div>
			)}
		</div>
	);
}

/**
 * Plain-language security explainer for the Phone Access flow. The user is being
 * asked to move a trading key onto a phone with no wallet, so the flow states what
 * is encrypted, what is sent where, how long it lasts and how to undo it — rather
 * than asking for trust.
 */
function LinkSecurityExplainer({ agentExpiresLabel }: { agentExpiresLabel: string }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="rounded-8 border border-stroke-weak bg-fill-weak">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
				className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
			>
				<span className="flex min-w-0 items-center gap-2">
					<ShieldCheckIcon className="size-4 shrink-0 text-icon" aria-hidden />
					<span className="text-xs font-semibold text-fg">
						<Trans>How this link is protected</Trans>
					</span>
				</span>
				<CaretDownIcon
					className={cn("size-4 shrink-0 text-fg-muted transition-transform", open && "rotate-180")}
					aria-hidden
				/>
			</button>
			{open && (
				<div className="space-y-2 border-t border-stroke-weak px-3 py-2.5 text-2xs leading-relaxed text-fg-muted">
					<p>
						<Trans>
							The link carries a freshly generated trading key. It is encrypted with AES-GCM, and the encryption key is
							derived from the pairing code with PBKDF2 (310,000 iterations) and a random salt. Without the code, the
							link cannot be read.
						</Trans>
					</p>
					<p>
						<Trans>
							The encrypted data sits after # in the URL, so it is not included in the HTTP request for the page. This
							flow does not upload the encrypted payload or pairing code. The app sends your account address to
							Hyperliquid to check the key is approved; approval, trading actions and account queries also go to
							Hyperliquid. Wallet connector and RPC services may receive connection data and retain logs.
						</Trans>{" "}
						<a
							href={GITHUB_URL}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stroke-focus"
						>
							<GithubLogoIcon className="size-3" aria-hidden />
							<Trans>Read the source</Trans>
						</a>
					</p>
					<p>
						<Trans>
							The link expires after 3 minutes. It can still be imported on another device before it expires. The key
							can keep trading until {agentExpiresLabel} (30 days from approval), and it can place orders but cannot
							withdraw funds.
						</Trans>
					</p>
					<p>
						<Trans>
							After import, the decrypted trading key is stored unencrypted in the phone's browser storage. "Forget this
							key" clears that local copy without revoking its Hyperliquid approval. "Reset phone access" replaces the
							approved Phone Access key on Hyperliquid. Anyone holding both the link and the code can import the trading
							key before the link expires, so treat them like a password.
						</Trans>
					</p>
				</div>
			)}
		</div>
	);
}

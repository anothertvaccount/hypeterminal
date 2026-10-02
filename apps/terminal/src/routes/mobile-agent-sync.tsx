import { Button, TextInput } from "@hypeterminal/ui";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	CheckCircleIcon,
	CopyIcon,
	DeviceMobileIcon,
	GithubLogoIcon,
	KeyIcon,
	SpinnerGapIcon,
	WalletIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import {
	type ChangeEvent,
	type FormEvent,
	forwardRef,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useConnection } from "wagmi";
import { WalletModal } from "@/components/trade/components/wallet-modal";
import { GITHUB_URL } from "@/config/app";
import { PAPER_TRADE } from "@/config/paper";
import { shortenAddress } from "@/lib/format";
import { useAgentWalletActions, useHyperliquid, writeAgentSessionAddress } from "@/lib/hyperliquid";
import {
	clearMobileSyncDraft,
	isMobileSyncEnvelopeExpired,
	markMobileSyncLinkConsumed,
	readMobileSyncDraft,
	saveMobileSyncDraft,
	wasMobileSyncLinkConsumed,
} from "@/lib/mobile-sync/draft-storage";
import { isMobileSyncImportError, verifyImportedMobileAgent } from "@/lib/mobile-sync/import-verification";
import {
	decryptMobileAgentSyncEnvelope,
	isMobileSyncError,
	MOBILE_SYNC_ROUTE_PATH,
	type MobileSyncEnvelope,
	MobileSyncError,
	parseMobileSyncUrl,
	readAndClearMobileSyncEnvelope,
} from "@/lib/mobile-sync/sync-core";
import { buildPageHead } from "@/lib/seo";

export const Route = createFileRoute("/mobile-agent-sync")({
	ssr: false,
	head: () =>
		buildPageHead({
			title: "Phone Access",
			path: MOBILE_SYNC_ROUTE_PATH,
			noIndex: true,
		}),
	component: MobileAgentSyncRoute,
});

type ImportStatus =
	| { state: "idle" }
	| { state: "importing" }
	| { state: "success"; userAddress: string; agentAddress: string };

type EnvelopeSource = "url" | "stored" | "manual";

function MobileAgentSyncRoute() {
	const { address } = useConnection();
	const { env, info } = useHyperliquid();
	const { setAgent } = useAgentWalletActions();
	const [envelope, setEnvelope] = useState<MobileSyncEnvelope | null>(null);
	const [envelopeSource, setEnvelopeSource] = useState<EnvelopeSource | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [linkInput, setLinkInput] = useState("");
	const [pairingCode, setPairingCode] = useState("");
	const [showLinkInput, setShowLinkInput] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [status, setStatus] = useState<ImportStatus>({ state: "idle" });
	const [walletModalOpen, setWalletModalOpen] = useState(false);
	const errorAlertRef = useRef<HTMLDivElement | null>(null);
	const pairingCodeInputRef = useRef<HTMLInputElement | null>(null);
	const pairingCodeSelectionRef = useRef<number | null>(null);

	const clearExpiredEnvelope = useCallback(() => {
		clearMobileSyncDraft();
		setEnvelope(null);
		setEnvelopeSource(null);
		setLoadError(t`This mobile link expired.`);
		setSubmitError(null);
		setPairingCode("");
		setStatus({ state: "idle" });
		setShowLinkInput(true);
	}, []);

	const clearInvalidEnvelope = useCallback((message: string) => {
		clearMobileSyncDraft();
		setEnvelope(null);
		setEnvelopeSource(null);
		setLoadError(message);
		setSubmitError(null);
		setPairingCode("");
		setStatus({ state: "idle" });
		setShowLinkInput(true);
	}, []);

	const loadEnvelope = useCallback(
		(nextEnvelope: MobileSyncEnvelope, source: EnvelopeSource) => {
			if (isMobileSyncEnvelopeExpired(nextEnvelope)) {
				clearExpiredEnvelope();
				return;
			}
			// Single-use on this device: a link that already imported a key here is spent.
			// (See markMobileSyncLinkConsumed for why this is a device guard, not a
			// security boundary — the chain-level answer is "Reset phone access".)
			if (wasMobileSyncLinkConsumed(nextEnvelope.syncId)) {
				clearMobileSyncDraft();
				setEnvelope(null);
				setEnvelopeSource(null);
				setLoadError(
					t`This link was already used on this phone. Create a new one on your desktop if you need another.`,
				);
				setSubmitError(null);
				setPairingCode("");
				setStatus({ state: "idle" });
				setShowLinkInput(true);
				return;
			}

			setEnvelope(nextEnvelope);
			setEnvelopeSource(source);
			setLoadError(null);
			setSubmitError(null);
			setPairingCode("");
			setStatus({ state: "idle" });
			setShowLinkInput(false);
			saveMobileSyncDraft(nextEnvelope);
		},
		[clearExpiredEnvelope],
	);

	const restoreStoredDraft = useCallback(() => {
		const storedDraft = readMobileSyncDraft();
		if (storedDraft.status === "found") {
			setEnvelope(storedDraft.draft.envelope);
			setEnvelopeSource("stored");
			setPairingCode("");
			setLoadError(null);
			setShowLinkInput(false);
			return;
		}
		if (storedDraft.status === "expired") {
			clearInvalidEnvelope(t`This mobile link expired.`);
			return;
		}
		if (storedDraft.status === "invalid") {
			clearInvalidEnvelope(t`Saved phone link was invalid. Paste the link again.`);
		}
	}, [clearInvalidEnvelope]);

	const processLocationSyncHash = useCallback(() => {
		if (window.location.hash) {
			try {
				const nextEnvelope = readAndClearMobileSyncEnvelope();
				loadEnvelope(nextEnvelope, "url");
			} catch (error) {
				clearInvalidEnvelope(getMobileSyncImportErrorMessage(error));
			}
			return;
		}

		restoreStoredDraft();
	}, [clearInvalidEnvelope, loadEnvelope, restoreStoredDraft]);

	useEffect(() => {
		processLocationSyncHash();

		function handleLocationChange() {
			// BASE_URL-aware: subpath deploys serve this route at /terminal/...
			const phonePath = `${import.meta.env.BASE_URL}mobile-agent-sync`.replace(/\/+$/, "");
			if (window.location.pathname.replace(/\/+$/, "") === phonePath && window.location.hash) {
				processLocationSyncHash();
			}
		}

		window.addEventListener("hashchange", handleLocationChange);
		window.addEventListener("popstate", handleLocationChange);
		return () => {
			window.removeEventListener("hashchange", handleLocationChange);
			window.removeEventListener("popstate", handleLocationChange);
		};
	}, [processLocationSyncHash]);

	useEffect(() => {
		if (!envelope || loadError || status.state === "success") return;

		const expiresInMs = envelope.expiresAtMs - Date.now();
		if (expiresInMs <= 0) {
			clearExpiredEnvelope();
			return;
		}

		const timeoutId = window.setTimeout(clearExpiredEnvelope, expiresInMs + 1);
		return () => window.clearTimeout(timeoutId);
	}, [clearExpiredEnvelope, envelope, loadError, status.state]);

	useLayoutEffect(() => {
		const nextSelectionStart = pairingCodeSelectionRef.current;
		pairingCodeSelectionRef.current = null;
		if (nextSelectionStart === null) return;

		const input = pairingCodeInputRef.current;
		if (!input || document.activeElement !== input) return;
		input.setSelectionRange(nextSelectionStart, nextSelectionStart);
	});

	useEffect(() => {
		if (!loadError && !submitError) return;
		errorAlertRef.current?.focus();
	}, [loadError, submitError]);

	function handleLoadPastedLink(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();

		try {
			const nextEnvelope = parseMobileSyncUrl(linkInput.trim());
			setLinkInput("");
			loadEnvelope(nextEnvelope, "manual");
		} catch (error) {
			clearMobileSyncDraft();
			setEnvelope(null);
			setEnvelopeSource(null);
			setLoadError(getMobileSyncImportErrorMessage(error));
			setSubmitError(null);
			setPairingCode("");
			setStatus({ state: "idle" });
			setShowLinkInput(true);
		}
	}

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!envelope || status.state === "importing") return;

		setSubmitError(null);
		// No owner wallet is required on the phone. The sealed link + pairing code IS
		// the credential; the binding is the on-chain check below — the agent must
		// really be an approved (trade-only, time-boxed) agent of the account the
		// link names, which a fabricated link cannot produce. Connecting a wallet
		// here is an OPTIONAL extra proof that the account is yours.
		const ownerAddress = address;
		setStatus({ state: "importing" });

		try {
			const imported = await decryptMobileAgentSyncEnvelope(envelope, pairingCode, {
				currentOrigin: window.location.origin,
				expectedEnv: env,
				// Undefined without a connected wallet → the account match is decided by
				// the on-chain agent check instead; a connected wallet must still match.
				expectedUserAddress: ownerAddress ?? undefined,
			});
			// The agent was approved on desktop moments ago; Hyperliquid can take a
			// few seconds to list it, so retry before telling the user it is unapproved.
			let extraAgents: Awaited<ReturnType<typeof info.extraAgents>> = [];
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					extraAgents = (await info.extraAgents({ user: ownerAddress ?? imported.userAddress })) ?? [];
				} catch {
					extraAgents = [];
				}
				if (extraAgents.some((agent) => agent.address?.toLowerCase() === imported.agentAddress.toLowerCase())) {
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 700 : 1500));
			}
			// Preview links never register the agent on Hyperliquid (no wallet
			// signature) — honor the embedded preview marker by supplying the
			// registry record locally. Harmless in preview: the phone trades
			// simulated funds and the link is AES-sealed + pairing-code gated.
			if (PAPER_TRADE && imported.preview === true) {
				extraAgents = [
					{
						address: imported.agentAddress,
						name: imported.agentName,
						validUntil: imported.agentValidUntilMs,
					},
					...extraAgents,
				];
			}
			const expectedOwner = ownerAddress ?? imported.userAddress;
			if (!expectedOwner) {
				throw new MobileSyncError("account_mismatch");
			}
			const verifiedAgent = verifyImportedMobileAgent({
				imported,
				extraAgents,
				expectedEnv: env,
				// Preview links without a wallet fall back to the link's own owner claim
				// (gated by the embedded preview marker); everything else needs the
				// connected wallet or the import fails with the account mismatch.
				expectedUserAddress: expectedOwner,
			});
			const { privateKey, publicKey, ...metadata } = verifiedAgent;

			setAgent(imported.env, imported.userAddress, privateKey, publicKey, metadata);
			// Spend the link: it cannot be imported again on this phone.
			markMobileSyncLinkConsumed(imported.syncId);
			clearMobileSyncDraft();
			// Record which account this device trades: from here on the app loads its
			// balances/positions and signs through this key with no wallet connected.
			writeAgentSessionAddress(env, imported.userAddress);
			setEnvelope(null);
			setEnvelopeSource(null);
			setPairingCode("");
			setStatus({
				state: "success",
				userAddress: imported.userAddress,
				agentAddress: imported.agentAddress,
			});
		} catch (error) {
			setSubmitError(getMobileSyncImportErrorMessage(error));
			setStatus({ state: "idle" });
		}
	}

	function handleResetLink() {
		clearMobileSyncDraft();
		setEnvelope(null);
		setEnvelopeSource(null);
		setLoadError(null);
		setLinkInput("");
		setPairingCode("");
		setSubmitError(null);
		setStatus({ state: "idle" });
		setShowLinkInput(false);
	}

	async function handlePastePairingCode() {
		if (!navigator.clipboard?.readText) {
			setSubmitError(t`Clipboard paste is not available. Paste from the keyboard menu or type the code manually.`);
			return;
		}

		try {
			const clipboardText = await navigator.clipboard.readText();
			const nextPairingCode = formatPairingCodeInput(clipboardText);
			if (nextPairingCode.replace(/[\s-]/g, "").length !== 16) {
				setSubmitError(t`Clipboard does not contain a pairing code.`);
				return;
			}
			setPairingCode(nextPairingCode);
			setSubmitError(null);
		} catch {
			setSubmitError(t`Clipboard paste was blocked. Paste from the keyboard menu or type the code manually.`);
		}
	}

	const isImporting = status.state === "importing";
	const pairingCodeReady = pairingCode.replace(/[\s-]/g, "").length === 16;
	const pairingCodeDisabled = !envelope || !!loadError || isImporting || status.state === "success";
	const importDisabled = !envelope || !!loadError || isImporting || status.state === "success" || !pairingCodeReady;
	const needsPastedLink = !envelope || !!loadError;
	const showPhoneLinkForm = needsPastedLink || showLinkInput;
	const handleLinkInputChange = (event: ChangeEvent<HTMLInputElement>) => setLinkInput(event.target.value);
	const handlePairingCodeChange = (event: ChangeEvent<HTMLInputElement>) => {
		pairingCodeSelectionRef.current = getFormattedPairingCodeCaretIndex(
			event.target.value,
			event.target.selectionStart ?? event.target.value.length,
		);
		const nextPairingCode = formatPairingCodeInput(event.target.value);
		setPairingCode(nextPairingCode);
		setSubmitError(null);
	};

	return (
		<>
			<main className="min-h-[100dvh] bg-background px-4 py-5 text-fg sm:px-6">
				<div className="mx-auto flex min-h-[calc(100dvh-2.5rem)] w-full max-w-md flex-col justify-center">
					<div className="rounded-12 border border-stroke-weak bg-overlay shadow-overlay">
						<div className="border-b border-stroke-weak p-4">
							<div className="flex items-center gap-2">
								<DeviceMobileIcon className="size-5 text-brand" weight="duotone" aria-hidden />
								<h1 className="text-base font-semibold text-fg">
									<Trans>Import phone access</Trans>
								</h1>
							</div>
							<p className="mt-1 text-xs text-fg-muted">
								<Trans>Open the phone link, then enter the pairing code shown on desktop.</Trans>
							</p>
						</div>

						<div className="space-y-4 p-4">
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
										<Trans>No wallet connected</Trans>
									)}
								</span>
							</div>

							{envelope && !loadError && (
								<LoadedLinkPanel
									envelope={envelope}
									env={env}
									connectedAddress={address}
									pairingCodeReady={pairingCodeReady}
									source={envelopeSource}
									onReset={handleResetLink}
								/>
							)}
							{!address && <ConnectWalletCallout onConnect={() => setWalletModalOpen(true)} />}
							{loadError && <ErrorCallout ref={errorAlertRef} message={loadError} />}
							{submitError && !loadError && <ErrorCallout ref={errorAlertRef} message={submitError} />}
							{submitError && loadError && <ErrorCallout message={submitError} />}

							{status.state === "success" ? (
								<SuccessPanel userAddress={status.userAddress} agentAddress={status.agentAddress} />
							) : (
								<div className="space-y-3">
									{envelope && !loadError && !showLinkInput && (
										<Button
											type="button"
											variant="outline"
											intent="neutral"
											size="sm"
											className="w-full"
											onClick={() => setShowLinkInput(true)}
										>
											<Trans>Use a different phone link</Trans>
										</Button>
									)}

									{showPhoneLinkForm && (
										<form className="space-y-3" onSubmit={handleLoadPastedLink}>
											<TextInput
												label={t`Phone link`}
												value={linkInput}
												onChange={handleLinkInputChange}
												placeholder={t`Paste link from desktop`}
												autoCapitalize="none"
												autoCorrect="off"
												inputMode="url"
												type="url"
											/>
											<Button
												type="submit"
												variant="outline"
												intent="neutral"
												size="md"
												className="w-full"
												disabled={!linkInput.trim()}
											>
												<Trans>Use phone link</Trans>
											</Button>
											{envelope && !loadError && (
												<Button
													type="button"
													variant="ghost"
													intent="neutral"
													size="sm"
													className="w-full"
													onClick={() => {
														setShowLinkInput(false);
														setLinkInput("");
													}}
												>
													<Trans>Cancel</Trans>
												</Button>
											)}
										</form>
									)}

									<form className="space-y-3" onSubmit={handleSubmit}>
										<div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
											<TextInput
												ref={pairingCodeInputRef}
												label={t`Pairing code`}
												value={pairingCode}
												onChange={handlePairingCodeChange}
												placeholder="0000-0000-0000-0000"
												autoComplete="one-time-code"
												autoCapitalize="characters"
												autoCorrect="off"
												inputMode="text"
												pattern="[0-9A-Fa-f\\s-]*"
												maxLength={19}
												spellCheck={false}
												iconLeft={<KeyIcon className="size-4" aria-hidden />}
												disabled={pairingCodeDisabled}
											/>
											<Button
												type="button"
												variant="outline"
												intent="neutral"
												size="md"
												className="sm:w-auto"
												disabled={pairingCodeDisabled}
												iconLeft={<CopyIcon className="size-4" aria-hidden />}
												onClick={handlePastePairingCode}
											>
												<Trans>Paste code</Trans>
											</Button>
										</div>
										<Button
											type="submit"
											variant="filled"
											intent="brand"
											size="md"
											className="w-full"
											disabled={importDisabled}
											iconLeft={
												isImporting ? (
													<SpinnerGapIcon className="size-4 animate-spin" aria-hidden />
												) : (
													<DeviceMobileIcon className="size-4" aria-hidden />
												)
											}
										>
											{isImporting ? <Trans>Importing...</Trans> : <Trans>Import phone access</Trans>}
										</Button>
									</form>
								</div>
							)}
						</div>
					</div>
				</div>
			</main>
			<WalletModal open={walletModalOpen} onOpenChange={setWalletModalOpen} />
		</>
	);
}

function LoadedLinkPanel({
	envelope,
	env,
	connectedAddress,
	pairingCodeReady,
	source,
	onReset,
}: {
	envelope: MobileSyncEnvelope;
	env: string;
	connectedAddress: string | undefined;
	pairingCodeReady: boolean;
	source: EnvelopeSource | null;
	onReset: () => void;
}) {
	const expiresAtLabel = new Date(envelope.expiresAtMs).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
	const syncPreview = envelope.syncId.slice(0, 8);

	return (
		<div className="space-y-3 rounded-8 border border-stroke-brand-strong/25 bg-fill-weak p-3">
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 items-start gap-2">
					<CheckCircleIcon className="mt-0.5 size-5 shrink-0 text-success" weight="fill" aria-hidden />
					<div className="min-w-0">
						<p className="text-sm font-semibold text-fg">
							<Trans>Phone link loaded</Trans>
						</p>
						<p className="mt-0.5 truncate text-xs text-fg-muted">
							{source === "stored" ? (
								<Trans>Recovered after reload. Expires {expiresAtLabel}.</Trans>
							) : (
								<Trans>Expires {expiresAtLabel}.</Trans>
							)}
						</p>
					</div>
				</div>
				<button
					type="button"
					onClick={onReset}
					className="shrink-0 rounded-xs px-2 py-1 text-xs font-medium text-fg-muted hover:bg-fill-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stroke-focus"
				>
					<Trans>Reset</Trans>
				</button>
			</div>

			<div className="grid gap-2 text-xs">
				<RequirementRow label={t`Sync ID`} value={syncPreview} complete />
				<RequirementRow label={t`Network`} value={env} complete />
				<RequirementRow
					label={t`Owner wallet`}
					value={connectedAddress ? shortenAddress(connectedAddress) : t`Connect to verify`}
					complete={!!connectedAddress}
				/>
				<RequirementRow
					label={t`Pairing code`}
					value={pairingCodeReady ? t`Ready` : t`Enter the desktop code`}
					complete={pairingCodeReady}
				/>
			</div>

			{/* What this page just did, in plain terms — the user is handing a trading
			    key to a phone, so say where the data went and what is kept. */}
			<div className="space-y-1.5 rounded-8 border border-stroke-weak bg-background p-3 text-2xs leading-relaxed text-fg-muted">
				<p className="font-semibold text-fg">
					<Trans>What happens when you import</Trans>
				</p>
				<p>
					<Trans>
						The link arrived encrypted (AES-GCM). Your pairing code decrypts it in this browser — it is never sent
						anywhere. The part of the link after the # was never sent to the website either, and this site has no
						backend, so there is no copy of your key on any server.
					</Trans>{" "}
					<a
						href={GITHUB_URL}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stroke-focus"
					>
						<GithubLogoIcon className="size-3" aria-hidden />
						<Trans>
							It is open source — browse the repository and see there is no server-side code that could hold your key.
						</Trans>
					</a>
				</p>
				<p>
					<Trans>
						Only your account address was checked against Hyperliquid's public API to confirm the key is approved. After
						import the key is stored in this browser only, where it can place orders but never withdraw.
					</Trans>
				</p>
				<p>
					<Trans>
						The code works for 3 minutes, and this phone will not accept the same link twice. Use "Forget this key" in
						Account to erase it here, or "Reset phone access" on desktop to revoke it everywhere at once.
					</Trans>
				</p>
			</div>
		</div>
	);
}

function RequirementRow({ label, value, complete }: { label: string; value: string; complete: boolean }) {
	return (
		<div className="flex items-center justify-between gap-3 rounded-8 border border-stroke-weak bg-background px-3 py-2">
			<span className="text-fg-muted">{label}</span>
			<span className="flex min-w-0 items-center gap-1.5 font-medium text-fg">
				<span
					className={
						complete ? "size-1.5 shrink-0 rounded-full bg-success" : "size-1.5 shrink-0 rounded-full bg-warning"
					}
					aria-hidden
				/>
				<span className="truncate">{value}</span>
			</span>
		</div>
	);
}

const ErrorCallout = forwardRef<HTMLDivElement, { message: string }>(function ErrorCallout({ message }, ref) {
	return (
		<div
			ref={ref}
			role="alert"
			tabIndex={-1}
			className="flex items-start gap-2 rounded-8 border border-stroke-error-strong/25 bg-error-soft p-3 text-xs text-error"
		>
			<WarningCircleIcon className="mt-0.5 size-4 shrink-0" weight="fill" aria-hidden />
			<p>{message}</p>
		</div>
	);
});

function ConnectWalletCallout({ onConnect }: { onConnect: () => void }) {
	return (
		<div className="space-y-3 rounded-8 border border-stroke-warning-strong/25 bg-warning-soft p-3 text-xs">
			<div className="flex items-start gap-2">
				<WarningCircleIcon className="mt-0.5 size-4 shrink-0 text-warning" weight="fill" aria-hidden />
				<p className="text-warning">
					{PAPER_TRADE ? (
						<Trans>No wallet needed in preview — the pairing code unlocks this link on its own.</Trans>
					) : (
						<Trans>
							No wallet needed on this phone — the link and pairing code unlock trading by themselves. Anyone holding
							both can trade this account (withdrawals are impossible), so treat them like a password. Connect a wallet
							only to verify the account is yours.
						</Trans>
					)}
				</p>
			</div>
			<Button
				type="button"
				variant="outline"
				intent="neutral"
				size="sm"
				className="w-full"
				iconLeft={<WalletIcon className="size-3.5" aria-hidden />}
				onClick={onConnect}
			>
				<Trans>Connect wallet</Trans>
			</Button>
		</div>
	);
}

function SuccessPanel({ userAddress, agentAddress }: { userAddress: string; agentAddress: string }) {
	return (
		<div className="space-y-3">
			<div className="flex items-start gap-2 rounded-8 border border-stroke-brand-strong/25 bg-fill-weak p-3">
				<CheckCircleIcon className="mt-0.5 size-5 shrink-0 text-success" weight="fill" aria-hidden />
				<div className="min-w-0">
					<p className="text-sm font-semibold text-fg">
						<Trans>Phone access ready</Trans>
					</p>
					<p className="mt-1 truncate font-mono text-xs text-fg-muted">{agentAddress}</p>
				</div>
			</div>
			<div className="rounded-8 border border-stroke-weak bg-fill-weak p-3 text-xs">
				<p className="text-fg-muted">
					<Trans>Owner account</Trans>
				</p>
				<p className="mt-1 truncate font-mono font-semibold text-fg">{userAddress}</p>
			</div>
			<Button
				type="button"
				variant="outline"
				intent="neutral"
				size="md"
				className="w-full"
				onClick={() => window.location.assign(import.meta.env.BASE_URL)}
			>
				<Trans>Open terminal</Trans>
			</Button>
		</div>
	);
}

function formatPairingCodeInput(value: string): string {
	const cleaned = value
		.toUpperCase()
		.replace(/[^0-9A-F]/g, "")
		.slice(0, 16);
	return cleaned.replace(/(.{4})(?=.)/g, "$1-");
}

function getFormattedPairingCodeCaretIndex(value: string, selectionStart: number): number {
	const hexBeforeSelection = value
		.slice(0, selectionStart)
		.toUpperCase()
		.replace(/[^0-9A-F]/g, "")
		.slice(0, 16).length;
	if (hexBeforeSelection <= 0) return 0;
	return hexBeforeSelection + Math.floor((hexBeforeSelection - 1) / 4);
}

function getMobileSyncImportErrorMessage(error: unknown): string {
	if (isMobileSyncError(error)) {
		switch (error.code) {
			case "invalid_pairing_code":
				return t`Enter the 16-character pairing code.`;
			case "missing_sync_fragment":
				return t`No mobile link found.`;
			case "sync_payload_in_query":
			case "sync_payload_in_path":
			case "unknown_fragment_key":
			case "invalid_payload_encoding":
			case "invalid_envelope":
			case "invalid_plaintext":
			case "agent_key_mismatch":
				return t`This is not a valid HypeTerminal mobile link.`;
			case "expired_payload":
				return t`This mobile link expired.`;
			case "decrypt_failed":
				return t`Pairing code does not match this link.`;
			case "origin_mismatch":
				return t`This link was created for a different site.`;
			case "env_mismatch":
				return t`This link was created for a different network.`;
			case "account_mismatch":
				return t`Connect the same wallet used on desktop.`;
		}
	}

	if (isMobileSyncImportError(error)) {
		return t`This phone link is not approved on Hyperliquid.`;
	}

	if (error instanceof TypeError) {
		return t`Paste the full phone link from desktop.`;
	}

	return error instanceof Error ? error.message : t`Could not import phone access.`;
}

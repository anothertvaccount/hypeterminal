import { FlaskIcon, WalletIcon } from "@phosphor-icons/react";
import type { Address } from "viem";
import type { Connector } from "wagmi";
import { RECENT_WALLETS_LIMIT, STORAGE_KEYS } from "@/config/app";
import { WALLET_INFO, type WalletInfo } from "@/config/wallets";

export type { WalletInfo } from "@/config/wallets";

export interface MockWalletConfig {
	name: string;
	address: Address;
	icon?: React.ComponentType<{ className?: string }>;
}

const DEFAULT_WALLET_INFO: WalletInfo = {
	icon: WalletIcon,
	description: "Connect using this wallet",
	popular: false,
	priority: 99,
};

const mockWalletRegistry = new Map<string, MockWalletConfig>();

export function registerMockWallet(config: MockWalletConfig): void {
	mockWalletRegistry.set(config.name, config);
}

export function getMockWalletConfig(name: string): MockWalletConfig | undefined {
	return mockWalletRegistry.get(name);
}

export function isMockConnector(connector: Connector): boolean {
	return connector.id === "mock" || connector.type === "mock";
}

export const WC_RETURN_MARKER = "wc";

/**
 * WalletConnect Link Mode redirect target: after approving, the wallet bounces the
 * user back to this exact app URL (instead of leaving them in the wallet). The
 * `?wc=1` marker tells the app a return happened so it can re-attach the approved
 * session, which the page reload discarded.
 */
export function buildWalletReturnUrl(origin: string, basePath: string): string {
	return `${origin}${basePath}?${WC_RETURN_MARKER}=1`;
}

/**
 * Consume the return marker: true when the user just came back from the wallet
 * (URL is rewritten in place so a refresh doesn't loop).
 */
export function consumeWalletReturnMarker(href: string = window.location.href): boolean {
	const url = new URL(href);
	if (url.searchParams.get(WC_RETURN_MARKER) !== "1") return false;
	url.searchParams.delete(WC_RETURN_MARKER);
	window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
	return true;
}

export function isWalletConnectConnector(connector: Connector): boolean {
	return connector.id === "walletConnect" || connector.type === "walletConnect";
}

function getMockWalletInfo(connector: Connector): WalletInfo {
	const config = mockWalletRegistry.get(connector.name);
	const address = config?.address;
	return {
		icon: FlaskIcon,
		description: address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Mock wallet for testing",
		popular: false,
		priority: 0,
	};
}

export function getWalletInfo(connector: Connector): WalletInfo {
	if (isMockConnector(connector)) {
		return getMockWalletInfo(connector);
	}
	const info = WALLET_INFO[connector.id] || WALLET_INFO[connector.name];
	if (info) return info;
	return DEFAULT_WALLET_INFO;
}

export function getRecentWallets(): string[] {
	if (typeof window === "undefined") return [];
	const raw = localStorage.getItem(STORAGE_KEYS.RECENT_WALLETS);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((id): id is string => typeof id === "string").slice(0, RECENT_WALLETS_LIMIT);
	} catch {
		return [];
	}
}

export function addRecentWallet(connectorId: string): void {
	if (typeof window === "undefined") return;
	const existing = getRecentWallets().filter((id) => id !== connectorId);
	const next = [connectorId, ...existing].slice(0, RECENT_WALLETS_LIMIT);
	localStorage.setItem(STORAGE_KEYS.RECENT_WALLETS, JSON.stringify(next));
}

export function splitWalletConnectors(connectors: readonly Connector[]): {
	mockConnectors: Connector[];
	regularConnectors: Connector[];
} {
	const mockConnectors: Connector[] = [];
	const regularConnectors: Connector[] = [];
	for (const connector of connectors) {
		if (isMockConnector(connector)) mockConnectors.push(connector);
		else regularConnectors.push(connector);
	}
	return { mockConnectors, regularConnectors };
}

export function sortWalletConnectors(connectors: readonly Connector[], recentWallets: readonly string[]): Connector[] {
	function recentRank(connectorId: string) {
		const index = recentWallets.indexOf(connectorId);
		return index === -1 ? Number.POSITIVE_INFINITY : index;
	}

	return [...connectors].sort((a, b) => {
		const rankA = recentRank(a.id);
		const rankB = recentRank(b.id);
		if (rankA !== rankB) return rankA - rankB;
		const priorityA = getWalletInfo(a).priority ?? 50;
		const priorityB = getWalletInfo(b).priority ?? 50;
		if (priorityA !== priorityB) return priorityA - priorityB;
		return a.name.localeCompare(b.name);
	});
}

export function getWalletConnectorGroups(connectors: readonly Connector[], recentWallets: readonly string[]) {
	const { mockConnectors, regularConnectors } = splitWalletConnectors(connectors);
	return {
		mockConnectors,
		popular: sortWalletConnectors(
			regularConnectors.filter((connector) => getWalletInfo(connector).popular),
			recentWallets,
		),
		other: sortWalletConnectors(
			regularConnectors.filter((connector) => !getWalletInfo(connector).popular),
			recentWallets,
		),
	};
}

type ConnectorMessage = { type?: string; data?: unknown };
type ConnectorMessageHandler = (message: ConnectorMessage) => void;
type ConnectorEmitter = {
	on(eventName: "message", handler: ConnectorMessageHandler): void;
	off(eventName: "message", handler: ConnectorMessageHandler): void;
};

/**
 * Re-run wagmi's reconnect — but only once the connector is actually usable.
 *
 * WalletConnect's provider initializes asynchronously from IndexedDB. Asking the
 * connector to reconnect before that finishes makes the SDK call `provider.request`
 * on `undefined` → "Cannot read properties of undefined (reading 'request')".
 * So for WalletConnect we wait (up to ~3s) for the provider to appear, and every
 * path is wrapped: a failed resume must never surface as an unhandled error —
 * the user can always connect manually from the wallet list.
 */
export async function reconnectWhenReady(
	connectors: readonly Connector[],
	reconnect: () => void,
	{ attempts = 20, intervalMs = 150 }: { attempts?: number; intervalMs?: number } = {},
): Promise<boolean> {
	const walletConnect = connectors.find(isWalletConnectConnector);
	if (!walletConnect) {
		try {
			reconnect();
			return true;
		} catch {
			return false;
		}
	}
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			const provider = await walletConnect.getProvider();
			if (provider) {
				reconnect();
				return true;
			}
		} catch {
			return false;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	return false;
}

/**
 * Which wallet app is behind the active connector, and how to open it.
 *
 * A WalletConnect session reports the connected wallet through the session peer's
 * metadata, so "the account is connected via walletConnect" is not enough to know
 * that the person is in MetaMask — we read the peer name and match it against the
 * known wallets. Injected/extension wallets already live in the page, so they get no
 * button.
 */
export function resolveWalletDeepLink(input: {
	connectorId?: string;
	peerName?: string;
}): { name: string; deepLink: string } | null {
	const peer = (input.peerName ?? "").toLowerCase();
	const candidates: string[] = [];
	if (peer) candidates.push(peer);
	if (input.connectorId) candidates.push(input.connectorId.toLowerCase());
	for (const needle of candidates) {
		for (const [key, info] of Object.entries(WALLET_INFO)) {
			if (!info.deepLink) continue;
			const keyLower = key.toLowerCase();
			if (keyLower.includes("walletconnect") || keyLower === "inject") continue;
			if (needle.includes(keyLower) || keyLower.includes(needle)) {
				return {
					name: key.replace(/^metaMask$/, "MetaMask").replace(/^coinbase$/, "Coinbase Wallet"),
					deepLink: info.deepLink,
				};
			}
		}
	}
	return null;
}

/** Peer wallet name from a live WalletConnect session (best effort, never throws). */
export async function readWalletConnectPeerName(connector: Connector | undefined): Promise<string | undefined> {
	if (!connector || !isWalletConnectConnector(connector)) return undefined;
	try {
		const provider = (await connector.getProvider()) as
			| { session?: { peer?: { metadata?: { name?: string } } } }
			| undefined;
		return provider?.session?.peer?.metadata?.name;
	} catch {
		return undefined;
	}
}

export function subscribeWalletConnectUri(connector: Connector, onUri: (uri: string) => void): () => void {
	if (!isWalletConnectConnector(connector)) return () => {};
	const emitter = (connector as Connector & { emitter?: ConnectorEmitter }).emitter;
	if (!emitter) return () => {};

	function handleMessage(message: ConnectorMessage) {
		if (message.type === "display_uri" && typeof message.data === "string") {
			onUri(message.data);
		}
	}

	emitter.on("message", handleMessage);
	return () => emitter.off("message", handleMessage);
}

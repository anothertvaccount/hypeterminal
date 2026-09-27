import { HyperliquidProvider, PERSISTED_QUERY_PREFIX } from "@hypeterminal/hl-react";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { useEffect } from "react";
import { useConnection, useConnectors, useReconnect, WagmiProvider } from "wagmi";
import { APP_NAME, RQ_CACHE_BUSTER, STORAGE_KEYS } from "@/config/app";
import { DEFAULT_BUILDER_CONFIG } from "@/config/hyperliquid";
import { RQ_CACHE_MAX_AGE_MS } from "@/config/time";
import { config } from "@/config/wagmi";
import { useAgentSessionAddress } from "@/lib/hyperliquid";
import { MarketsProvider } from "@/lib/hyperliquid/markets";
import { getNetwork } from "@/lib/network";
import { consumeWalletReturnMarker, reconnectWhenReady } from "@/lib/wallet-utils";
import "@/lib/i18n";

const network = getNetwork();
const env = network === "testnet" ? "Testnet" : "Mainnet";

const isServer = typeof document === "undefined";

if (!isServer) {
	try {
		localStorage.removeItem(STORAGE_KEYS.LEGACY_METADATA);
	} catch {}
}

const persister = isServer
	? null
	: createSyncStoragePersister({
			storage: window.localStorage,
			key: STORAGE_KEYS.RQ_CACHE,
			throttleTime: 1000,
		});

export function getRootProviderContext() {
	const queryClient = new QueryClient();
	return { queryClient };
}

function HyperliquidBridge({ children }: { children: React.ReactNode }) {
	const { address } = useConnection();
	// Linked-key sessions (Phone Access) have no connected wallet — load the account
	// the key trades so balances, positions and history follow it.
	const sessionAddress = useAgentSessionAddress(env);

	return (
		<HyperliquidProvider
			env={env}
			userAddress={address ?? sessionAddress ?? undefined}
			builderConfig={DEFAULT_BUILDER_CONFIG}
			agentName={APP_NAME}
		>
			<MarketsProvider>{children}</MarketsProvider>
		</HyperliquidProvider>
	);
}

/**
 * WalletConnect "bounce back" support: the wallet returns the user to
 * `<app>?wc=1` after they approve (Link Mode redirect). The pending proposal is
 * gone by then — the app was reloaded/backgrounded — but the approved session
 * still lives in the provider, so reconnect() re-attaches it automatically and
 * the user lands already signed in.
 */
function WalletReturnResume() {
	const { isConnected, isConnecting } = useConnection();
	const { reconnect } = useReconnect();
	const connectors = useConnectors();

	useEffect(() => {
		if (typeof window === "undefined") return;
		if (isConnected || isConnecting) return;
		if (!consumeWalletReturnMarker()) return;
		void reconnectWhenReady(connectors, reconnect);
	}, [connectors, isConnected, isConnecting, reconnect]);

	return null;
}

export function RootProvider({ children, queryClient }: { children: React.ReactNode; queryClient: QueryClient }) {
	if (isServer || !persister) {
		return (
			<WagmiProvider config={config}>
				<WalletReturnResume />
				<QueryClientProvider client={queryClient}>
					<I18nProvider i18n={i18n}>
						<HyperliquidBridge>{children}</HyperliquidBridge>
					</I18nProvider>
				</QueryClientProvider>
			</WagmiProvider>
		);
	}

	return (
		<WagmiProvider config={config}>
			<WalletReturnResume />
			<PersistQueryClientProvider
				client={queryClient}
				persistOptions={{
					persister,
					maxAge: RQ_CACHE_MAX_AGE_MS,
					buster: RQ_CACHE_BUSTER,
					dehydrateOptions: {
						shouldDehydrateQuery: (query) => query.queryKey[0] === PERSISTED_QUERY_PREFIX,
					},
				}}
			>
				<I18nProvider i18n={i18n}>
					<HyperliquidBridge>{children}</HyperliquidBridge>
				</I18nProvider>
			</PersistQueryClientProvider>
		</WagmiProvider>
	);
}

import type { Address } from "viem";
import { useConnection } from "wagmi";
import { useHyperliquid } from "../provider";
import { useAgentSessionAddress } from "./agent-storage";

export interface TradingSession {
	/**
	 * The account the UI should read and trade: the connected wallet when there is
	 * one, otherwise the owner recorded by a linked Phone Access key.
	 */
	address: Address | undefined;
	/** True when the account comes from a connected browser wallet. */
	isWallet: boolean;
	/** Owner of the trading key linked on this device, if any (null on desktop). */
	sessionOwner: Address | null;
	/** True when an account is selected — account queries may run. */
	isActive: boolean;
	/** Raw wagmi connection flag; only for wallet-specific UI (disconnect, signing). */
	isWalletConnected: boolean;
	isWalletConnecting: boolean;
}

/**
 * Single source of truth for "whose account is this session showing?".
 *
 * A phone linked through Phone Access has NO wallet: the agent key is filed under
 * the owner address recorded at import (`hyperliquid_agent_session_<env>`). Gating
 * account data on wagmi's `isConnected` therefore blanks out balances, positions
 * and history on exactly the devices the feature exists for — use `isActive` and
 * `address` from here instead, and reserve `isWalletConnected` for things that
 * genuinely need the wallet (disconnect button, `approveAgent`, deposits).
 */
export function useTradingSession(): TradingSession {
	const { env } = useHyperliquid();
	const { address: walletAddress, isConnected, isConnecting } = useConnection();
	const sessionOwner = useAgentSessionAddress(env);
	const address = walletAddress ?? sessionOwner ?? undefined;

	return {
		address,
		isWallet: !!walletAddress,
		sessionOwner,
		isActive: !!address,
		isWalletConnected: isConnected,
		isWalletConnecting: isConnecting,
	};
}

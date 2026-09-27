import { useSyncExternalStore } from "react";
import type { Address, Hex } from "viem";
import { z } from "zod";
import { LRU } from "../lru";
import type { AgentWallet, HyperliquidEnv } from "./types";

const privateKeySchema = z
	.string()
	.regex(/^0x[0-9a-fA-F]{64}$/)
	.transform((v) => v.toLowerCase() as Hex);

const addressSchema = z
	.string()
	.regex(/^0x[0-9a-fA-F]{40}$/)
	.transform((v) => v.toLowerCase() as Address);

const publicKeySchema = z
	.string()
	.regex(/^0x[0-9a-fA-F]{40}$/)
	.transform((v) => v.toLowerCase() as Address);

const agentWalletSchema = z.object({
	privateKey: privateKeySchema,
	publicKey: publicKeySchema,
	source: z.enum(["local-registration", "mobile-sync"]).optional(),
	agentNameBase: z.string().min(1).optional(),
	agentName: z.string().min(1).optional(),
	agentValidUntilMs: z.number().int().positive().optional(),
	importedAtMs: z.number().int().positive().optional(),
	syncId: z.string().min(1).optional(),
});

export type AgentWalletMetadata = Omit<AgentWallet, "privateKey" | "publicKey">;

function getStorageKey(env: HyperliquidEnv, userAddress: string): string {
	return `hyperliquid_agent_${env}_${userAddress.toLowerCase()}`;
}

export function readAgentFromStorage(env: HyperliquidEnv, userAddress: string): AgentWallet | null {
	if (typeof window === "undefined") return null;

	try {
		const key = getStorageKey(env, userAddress);
		const raw = localStorage.getItem(key);
		if (!raw) return null;

		const parsed = JSON.parse(raw);
		return agentWalletSchema.parse(parsed);
	} catch {
		return null;
	}
}

export function writeAgentToStorage(
	env: HyperliquidEnv,
	userAddress: string,
	privateKey: string,
	publicKey: string,
	metadata: AgentWalletMetadata = {},
): void {
	if (typeof window === "undefined") return;

	try {
		const key = getStorageKey(env, userAddress);
		const data: AgentWallet = {
			privateKey: privateKeySchema.parse(privateKey),
			publicKey: publicKeySchema.parse(publicKey),
			...metadata,
		};
		localStorage.setItem(key, JSON.stringify(agentWalletSchema.parse(data)));
		window.dispatchEvent(new StorageEvent("storage", { key }));
	} catch {
		// Silent fail for storage errors
	}
}

export function removeAgentFromStorage(env: HyperliquidEnv, userAddress: string): void {
	if (typeof window === "undefined") return;

	const key = getStorageKey(env, userAddress);
	localStorage.removeItem(key);
	window.dispatchEvent(new StorageEvent("storage", { key }));
}

// Bounded cache: entries are (env, address) pairs, keyed so useSyncExternalStore
// returns a stable reference across renders. Cap matches the signer/trading
// caches in clients.ts — a user switching between more wallets simply evicts
// older entries.
//
// Security note: entries contain the agent's private key material in memory.
// That's acceptable for session-length use (the keys also live in localStorage
// for persistence) but callers in high-security contexts should consider a
// shorter-lived store and a forced eviction on address change.
// ---------------------------------------------------------------------------
// Agent session pointer
//
// A linked phone (imported via Phone Access) has NO connected wallet — the agent
// record itself is stored under the OWNER address. The pointer records which
// account the linked key trades, so the app can load that account (balances,
// positions, agent status, signing) with nothing else connected.
// ---------------------------------------------------------------------------
const AGENT_SESSION_PREFIX = "hyperliquid_agent_session_";
let sessionVersion = 0;

function getAgentSessionKey(env: HyperliquidEnv): string {
	return `${AGENT_SESSION_PREFIX}${env}`;
}

/** Owner address of the trading key linked on this device, if any. */
export function readAgentSessionAddress(env: HyperliquidEnv): Address | null {
	if (typeof window === "undefined") return null;
	try {
		const raw = localStorage.getItem(getAgentSessionKey(env));
		if (!raw) return null;
		return addressSchema.parse(JSON.parse(raw).address ?? JSON.parse(raw));
	} catch {
		return null;
	}
}

export function writeAgentSessionAddress(env: HyperliquidEnv, ownerAddress: string): void {
	if (typeof window === "undefined") return;
	try {
		localStorage.setItem(getAgentSessionKey(env), JSON.stringify({ address: addressSchema.parse(ownerAddress) }));
		sessionVersion++;
		window.dispatchEvent(new StorageEvent("storage", { key: getAgentSessionKey(env) }));
	} catch {
		// Silent fail for storage errors — session bookkeeping must never break a flow.
	}
}

export function clearAgentSessionAddress(env: HyperliquidEnv): void {
	if (typeof window === "undefined") return;
	try {
		localStorage.removeItem(getAgentSessionKey(env));
		sessionVersion++;
		window.dispatchEvent(new StorageEvent("storage", { key: getAgentSessionKey(env) }));
	} catch {
		// Silent fail for storage errors.
	}
}

/** Reactive read of the linked-key account (works with no wallet connected). */
export function useAgentSessionAddress(env: HyperliquidEnv): Address | null {
	return useSyncExternalStore(
		(callback) => {
			if (typeof window === "undefined") return () => undefined;
			window.addEventListener("storage", callback);
			return () => window.removeEventListener("storage", callback);
		},
		() => {
			sessionVersion++;
			return readAgentSessionAddress(env);
		},
		() => null,
	);
}

/** @internal — exported only for tests; do not consume from outside this package. */
export const snapshotCache = new LRU<string, { value: AgentWallet | null; version: number }>(4);
let cacheVersion = 0;

const STORAGE_KEY_PREFIX = "hyperliquid_agent_";

// Single canonical derivation for the (env, address) cache key. Addresses from
// wagmi arrive EIP-55 checksum-cased; the storage key is always lowercase, so
// normalizing here keeps the set/read path and the StorageEvent invalidation
// path in lock-step.
function getCacheKey(env: HyperliquidEnv, userAddress: string): string {
	return `${env}:${userAddress.toLowerCase()}`;
}

function invalidateSnapshotCache() {
	cacheVersion++;
}

function invalidateSnapshotKey(storageKey: string | null) {
	// storageKey is null when localStorage.clear() fires the event; fall back
	// to a global bump in that case.
	if (storageKey === null || !storageKey.startsWith(STORAGE_KEY_PREFIX)) {
		invalidateSnapshotCache();
		return;
	}
	const rest = storageKey.slice(STORAGE_KEY_PREFIX.length);
	const underscore = rest.indexOf("_");
	if (underscore === -1) {
		invalidateSnapshotCache();
		return;
	}
	const env = rest.slice(0, underscore);
	const address = rest.slice(underscore + 1);
	snapshotCache.delete(getCacheKey(env as HyperliquidEnv, address));
}

/** @internal — exported only for tests; do not consume from outside this package. */
export function getCachedAgentSnapshot(env: HyperliquidEnv, userAddress: string): AgentWallet | null {
	const key = getCacheKey(env, userAddress);
	const entry = snapshotCache.get(key);
	if (entry && entry.version === cacheVersion) return entry.value;
	const value = readAgentFromStorage(env, userAddress);
	snapshotCache.set(key, { value, version: cacheVersion });
	return value;
}

/** @internal — exported only for tests; do not consume from outside this package. */
export function subscribeToStorage(callback: () => void): () => void {
	if (typeof window === "undefined") return () => {};
	function handleStorage(event: StorageEvent) {
		// Cross-tab StorageEvents carry the affected key; same-tab synthetic
		// events from writeAgentToStorage/removeAgentFromStorage carry it too.
		// Only invalidate the matching cache entry so other (env, address)
		// pairs keep their cached reads.
		invalidateSnapshotKey(event.key);
		callback();
	}
	window.addEventListener("storage", handleStorage);
	return () => window.removeEventListener("storage", handleStorage);
}

export function useAgentWalletStorage(env: HyperliquidEnv, userAddress: string | null | undefined): AgentWallet | null {
	return useSyncExternalStore(
		subscribeToStorage,
		() => {
			if (!userAddress) return null;
			return getCachedAgentSnapshot(env, userAddress);
		},
		() => null,
	);
}

export function useAgentWalletActions() {
	function setAgent(
		env: HyperliquidEnv,
		userAddress: string,
		privateKey: string,
		publicKey: string,
		metadata?: AgentWalletMetadata,
	) {
		writeAgentToStorage(env, userAddress, privateKey, publicKey, metadata);
	}

	function clearAgent(env: HyperliquidEnv, userAddress: string) {
		removeAgentFromStorage(env, userAddress);
	}

	return { setAgent, clearAgent };
}

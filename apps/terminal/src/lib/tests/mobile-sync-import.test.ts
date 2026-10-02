import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { markMobileSyncLinkConsumed, wasMobileSyncLinkConsumed } from "@/lib/mobile-sync/draft-storage";
import { MOBILE_SYNC_PAYLOAD_TTL_MS } from "@/lib/mobile-sync/sync-core";
import { MobileSyncImportError, verifyImportedMobileAgent } from "../mobile-sync/import-verification";
import { createMobileAgentSyncUrl, decryptMobileAgentSyncEnvelope, MobileSyncError } from "../mobile-sync/sync-core";

const NOW_MS = 1_779_364_227_000;
const APP_ORIGIN = "https://app.hypeterminal.com";
const USER_ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const OTHER_USER_ADDRESS = "0x2222222222222222222222222222222222222222" as const;
const AGENT_PRIVATE_KEY = `0x${"ab".repeat(32)}` as const;

async function createImportedFixture() {
	const sync = await createMobileAgentSyncUrl({
		appOrigin: APP_ORIGIN,
		env: "Mainnet",
		userAddress: USER_ADDRESS,
		agentPrivateKey: AGENT_PRIVATE_KEY,
		nowMs: NOW_MS,
	});
	const imported = await decryptMobileAgentSyncEnvelope(sync.envelope, sync.pairingCode, {
		currentOrigin: APP_ORIGIN,
		expectedEnv: "Mainnet",
		expectedUserAddress: USER_ADDRESS,
		nowMs: NOW_MS,
	});

	return { sync, imported };
}

describe("mobile sync import verification", () => {
	it("turns a decrypted and remotely approved import into a storage-ready agent wallet", async () => {
		const { sync, imported } = await createImportedFixture();
		const verifiedAgent = verifyImportedMobileAgent({
			imported,
			extraAgents: [{ address: sync.agentAddress, name: sync.agentName, validUntil: sync.agentValidUntilMs }],
			expectedEnv: "Mainnet",
			expectedUserAddress: USER_ADDRESS,
			nowMs: NOW_MS,
		});

		expect(verifiedAgent).toMatchObject({
			privateKey: AGENT_PRIVATE_KEY,
			publicKey: privateKeyToAccount(AGENT_PRIVATE_KEY).address.toLowerCase(),
			source: "mobile-sync",
			agentName: sync.agentName,
			agentValidUntilMs: sync.agentValidUntilMs,
			syncId: sync.syncId,
		});
	});

	it("rejects imports for the wrong connected account", async () => {
		const { sync, imported } = await createImportedFixture();

		expect(() =>
			verifyImportedMobileAgent({
				imported,
				extraAgents: [{ address: sync.agentAddress, name: sync.agentName, validUntil: sync.agentValidUntilMs }],
				expectedEnv: "Mainnet",
				expectedUserAddress: OTHER_USER_ADDRESS,
				nowMs: NOW_MS,
			}),
		).toThrow(MobileSyncError);
	});

	it("requires a connected owner account before storage", async () => {
		const { sync, imported } = await createImportedFixture();

		expect(() =>
			verifyImportedMobileAgent({
				imported,
				extraAgents: [{ address: sync.agentAddress, name: sync.agentName, validUntil: sync.agentValidUntilMs }],
				expectedEnv: "Mainnet",
				expectedUserAddress: undefined as never,
				nowMs: NOW_MS,
			}),
		).toThrow(MobileSyncError);
	});

	it("rejects mobile agents that are missing from remote approvals", async () => {
		const { imported } = await createImportedFixture();

		expect(() =>
			verifyImportedMobileAgent({
				imported,
				extraAgents: [],
				expectedEnv: "Mainnet",
				expectedUserAddress: USER_ADDRESS,
				nowMs: NOW_MS,
			}),
		).toThrow(MobileSyncImportError);
	});

	// The exchange may normalise the agent name or round `validUntil`, so binding is
	// on the agent ADDRESS plus a live window — a renamed/rounded approval is still
	// the same real agent, and the sealed link already proves key possession.
	it("accepts an approved agent whose name/expiry drifted, and rejects wrong or expired ones", async () => {
		const { sync, imported } = await createImportedFixture();
		const base = {
			imported,
			expectedEnv: "Mainnet" as const,
			expectedUserAddress: USER_ADDRESS,
			nowMs: NOW_MS,
		};

		expect(
			verifyImportedMobileAgent({
				...base,
				extraAgents: [
					{
						address: `0x${sync.agentAddress.slice(2).toUpperCase()}` as `0x${string}`,
						name: `${sync.agentName} (renamed)`,
						validUntil: NOW_MS + 1000,
					},
				],
			}),
		).toBeTruthy();

		// a different agent address is never this link's agent
		expect(() =>
			verifyImportedMobileAgent({
				...base,
				extraAgents: [
					{
						address: "0x1111111111111111111111111111111111111111",
						name: sync.agentName,
						validUntil: sync.agentValidUntilMs,
					},
				],
			}),
		).toThrow(MobileSyncImportError);

		// registered but expired → the trade window is gone
		expect(() =>
			verifyImportedMobileAgent({
				...base,
				extraAgents: [{ address: sync.agentAddress, name: sync.agentName, validUntil: NOW_MS - 1 }],
			}),
		).toThrow(MobileSyncImportError);
	});
});

/**
 * Single-use links: a link that already imported a key on this device is spent.
 * The TTL is deliberately short too — an offline handoff cannot burn a code
 * server-side, so the window is the real defence.
 */
describe("mobile sync single-use", () => {
	it("remembers a consumed link and refuses it afterwards", () => {
		const store = new Map<string, string>();
		const storage = {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
			removeItem: (key: string) => void store.delete(key),
			clear: () => store.clear(),
			key: () => "",
			length: 0,
		} as unknown as Storage;

		expect(wasMobileSyncLinkConsumed("sync-abc", { storage })).toBe(false);
		markMobileSyncLinkConsumed("sync-abc", { storage });
		expect(wasMobileSyncLinkConsumed("sync-abc", { storage })).toBe(true);
		// A different link is unaffected.
		expect(wasMobileSyncLinkConsumed("sync-xyz", { storage })).toBe(false);
	});

	it("never lets a storage failure block an import", () => {
		const broken = {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
			removeItem: () => {},
		} as unknown as Storage;
		expect(() => markMobileSyncLinkConsumed("sync-abc", { storage: broken })).not.toThrow();
		expect(wasMobileSyncLinkConsumed("sync-abc", { storage: broken })).toBe(false);
	});

	it("keeps the code window short", () => {
		expect(MOBILE_SYNC_PAYLOAD_TTL_MS).toBeLessThanOrEqual(5 * 60 * 1000);
	});
});

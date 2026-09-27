import type { AgentWallet } from "@hypeterminal/hl-react";
import { createMobileAgentWalletRecord } from "@hypeterminal/hl-react/signing/mobile-agent";
import type { ExtraAgentsResponse } from "@nktkas/hyperliquid";
import { type HyperliquidEnvName, type ImportedMobileAgent, MobileSyncError } from "./sync-core";

export type MobileSyncImportErrorCode = "unapproved_agent";

export class MobileSyncImportError extends Error {
	readonly code: MobileSyncImportErrorCode;

	constructor(code: MobileSyncImportErrorCode) {
		super(code === "unapproved_agent" ? "Phone link is not approved" : "Phone access import failed");
		this.name = "MobileSyncImportError";
		this.code = code;
	}
}

export interface VerifyImportedMobileAgentInput {
	imported: ImportedMobileAgent;
	extraAgents: ExtraAgentsResponse;
	expectedUserAddress: string;
	expectedEnv?: HyperliquidEnvName;
	nowMs?: number;
}

export function verifyImportedMobileAgent({
	imported,
	extraAgents,
	expectedUserAddress,
	expectedEnv,
	nowMs = Date.now(),
}: VerifyImportedMobileAgentInput): AgentWallet {
	if (expectedEnv && imported.env !== expectedEnv) {
		throw new MobileSyncError("env_mismatch");
	}
	if (!expectedUserAddress || imported.userAddress.toLowerCase() !== expectedUserAddress.toLowerCase()) {
		throw new MobileSyncError("account_mismatch");
	}

	const localAgent = createMobileAgentWalletRecord({
		privateKey: imported.agentPrivateKey,
		publicKey: imported.agentAddress,
		agentName: imported.agentName,
		agentValidUntilMs: imported.agentValidUntilMs,
		importedAtMs: imported.importedAtMs,
		syncId: imported.syncId,
	});
	// The agent ADDRESS is the identity: whoever holds the sealed link + pairing code
	// also holds the matching private key, and the registry proves that key is an
	// approved (trade-only) agent of the account. The exchange can normalise the
	// agent name or round `validUntil`, so binding on those exact values rejected
	// links that were genuinely approved — require the address and a live window.
	const remote = extraAgents.find(
		(agent) => (agent.address ?? "").toLowerCase() === imported.agentAddress.toLowerCase(),
	);
	if (!remote) throw new MobileSyncImportError("unapproved_agent");
	if (Number(remote.validUntil) <= nowMs) throw new MobileSyncImportError("unapproved_agent");

	return localAgent;
}

export function isMobileSyncImportError(error: unknown): error is MobileSyncImportError {
	return error instanceof MobileSyncImportError;
}

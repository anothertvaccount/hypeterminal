import type { ExtraAgentsResponse, MaxBuilderFeeResponse } from "@nktkas/hyperliquid";
import { type Address, zeroAddress } from "viem";
import { useConnection } from "wagmi";
import { useInfo } from "../hooks/useInfo";
import { useHyperliquid } from "../provider";
import { useAgentSessionAddress, useAgentWalletStorage } from "./agent-storage";
import { isAgentApproved, isBuilderFeeApproved } from "./agent-utils";
import type { BuilderConfig } from "./types";

export interface AgentRequirements {
	needsBuilderFee: boolean;
	needsAgent: boolean;
	signaturesRequired: number;
	isReady: boolean;
}

export interface UseAgentStatusResult extends AgentRequirements {
	isLoading: boolean;
	agentAddress: Address | null;
	refetch: () => Promise<AgentRequirements>;
}

function deriveRequirements(
	builderFeeData: MaxBuilderFeeResponse | undefined,
	extraAgentsData: ExtraAgentsResponse | undefined,
	localAgentPublicKey: Address | undefined,
	builderConfig: BuilderConfig | undefined,
): AgentRequirements {
	const hasBuilderConfig = !!builderConfig?.b;
	const builderFeeKnown = !hasBuilderConfig || builderFeeData !== undefined;
	const extraAgentsKnown = extraAgentsData !== undefined;

	const needsBuilderFee =
		hasBuilderConfig && builderFeeKnown && !isBuilderFeeApproved(builderFeeData, builderConfig?.f);
	const needsAgent = extraAgentsKnown && !isAgentApproved(extraAgentsData, localAgentPublicKey);
	const signaturesRequired = (needsBuilderFee ? 1 : 0) + (needsAgent ? 1 : 0);

	return {
		needsBuilderFee,
		needsAgent,
		signaturesRequired,
		isReady: builderFeeKnown && extraAgentsKnown && signaturesRequired === 0,
	};
}

export function useAgentStatus(): UseAgentStatusResult {
	const { env, builderConfig } = useHyperliquid();
	const { address: walletAddress } = useConnection();
	// Linked-key sessions (Phone Access) have no connected wallet — the key is
	// stored under the owner address recorded at import.
	const sessionAddress = useAgentSessionAddress(env);
	const address = walletAddress ?? sessionAddress;

	// Unconditional (hooks may not be conditional — the argument can be null).
	const localAgent = useAgentWalletStorage(env, address);
	const hasBuilderConfig = !!builderConfig?.b;
	const userAddress = address ?? zeroAddress;

	// These two reads GATE the trading signer: isReady is false until both are known,
	// so a single failed or rate-limited request used to leave the device permanently
	// unable to trade (with no error anywhere). Retry a few times before giving up,
	// and keep re-checking in the background while the key is still not ready so a
	// cold read recovers on its own.
	const readinessRetry = {
		retry: 3,
		retryDelay: (attempt: number) => Math.min(4_000, 500 * 2 ** attempt),
		retryDelayAttemptLimit: 2,
	};
	const builderFeeQuery = useInfo(
		"maxBuilderFee",
		{ user: userAddress, builder: builderConfig?.b ?? zeroAddress },
		{
			enabled: !!address && hasBuilderConfig,
			...readinessRetry,
		},
	);

	const extraAgentsQuery = useInfo(
		"extraAgents",
		{ user: userAddress },
		{
			enabled: !!address,
			...readinessRetry,
		},
	);

	const isLoading = builderFeeQuery.isLoading || extraAgentsQuery.isLoading;
	const requirements = deriveRequirements(
		builderFeeQuery.data,
		extraAgentsQuery.data,
		localAgent?.publicKey,
		builderConfig,
	);

	async function refetch(): Promise<AgentRequirements> {
		const [feeResult, agentsResult] = await Promise.all([builderFeeQuery.refetch(), extraAgentsQuery.refetch()]);

		if (hasBuilderConfig && feeResult.data === undefined) {
			throw new Error("Could not load builder fee status");
		}
		if (agentsResult.data === undefined) {
			throw new Error("Could not load agent status");
		}

		return deriveRequirements(feeResult.data, agentsResult.data, localAgent?.publicKey, builderConfig);
	}

	return {
		...requirements,
		isReady: !isLoading && requirements.isReady,
		isLoading,
		agentAddress: localAgent?.publicKey ?? null,
		refetch,
	};
}

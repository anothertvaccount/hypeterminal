// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { buildWalletReturnUrl, consumeWalletReturnMarker } from "@/lib/wallet-utils";

/**
 * WalletConnect "bounce back" plumbing:
 *  - the redirect the wallet uses after approval must point at THIS deployment
 *    with the `?wc=1` marker, and
 *  - consuming that marker must be idempotent (a refresh after the return must
 *    not re-trigger a resume loop).
 */
describe("walletconnect return-to-app", () => {
	it("builds a return url for the live origin and base path", () => {
		expect(buildWalletReturnUrl("https://charts.example.com", "/terminal/")).toBe(
			"https://charts.example.com/terminal/?wc=1",
		);
		expect(buildWalletReturnUrl("http://localhost:3000", "/")).toBe("http://localhost:3000/?wc=1");
	});

	it("consumes the marker exactly once and cleans the url", () => {
		window.history.replaceState(null, "", "/terminal/?wc=1");
		expect(consumeWalletReturnMarker()).toBe(true);
		expect(window.location.search).toBe("");
		// Second call must be a no-op so a refresh cannot loop the resume.
		expect(consumeWalletReturnMarker()).toBe(false);
	});

	it("leaves unrelated query params intact", () => {
		window.history.replaceState(null, "", "/terminal/?foo=bar&wc=1");
		expect(consumeWalletReturnMarker()).toBe(true);
		expect(window.location.search).toBe("?foo=bar");
	});
});

describe("reconnectWhenReady", () => {
	const wcConnector = (getProvider: () => Promise<unknown>) =>
		({ id: "walletConnect", type: "walletConnect", uid: "wc", getProvider }) as never;

	it("waits for the WalletConnect provider before reconnecting (no request on undefined)", async () => {
		const { reconnectWhenReady } = await import("@/lib/wallet-utils");
		let providerReady = false;
		let attempts = 0;
		const connectors = [
			wcConnector(async () => {
				attempts += 1;
				if (!providerReady) return undefined; // provider still initializing
				return { request: () => undefined };
			}),
		];
		const reconnect = vi.fn();
		const promise = reconnectWhenReady(connectors, reconnect, { attempts: 10, intervalMs: 1 });
		await new Promise((r) => setTimeout(r, 5));
		expect(reconnect).not.toHaveBeenCalled(); // must NOT fire while the provider is missing
		providerReady = true;
		const done = await promise;
		expect(done).toBe(true);
		expect(reconnect).toHaveBeenCalledTimes(1);
		expect(attempts).toBeGreaterThan(1);
	});

	it("never throws when the connector blows up", async () => {
		const { reconnectWhenReady } = await import("@/lib/wallet-utils");
		const connectors = [
			wcConnector(async () => {
				throw new Error("provider exploded");
			}),
		];
		const reconnect = vi.fn(() => {
			throw new Error("reconnect exploded");
		});
		await expect(reconnectWhenReady(connectors, reconnect, { attempts: 3, intervalMs: 1 })).resolves.toBe(false);
	});

	it("reconnects immediately for non-WalletConnect wallets", async () => {
		const { reconnectWhenReady } = await import("@/lib/wallet-utils");
		const reconnect = vi.fn();
		const ok = await reconnectWhenReady([{ id: "injected", type: "injected", uid: "i" }] as never, reconnect);
		expect(ok).toBe(true);
		expect(reconnect).toHaveBeenCalledTimes(1);
	});
});

describe("agent session pointer (wallet-less Phone Access)", () => {
	it("records, reads and clears which account the linked key trades", async () => {
		const { clearAgentSessionAddress, readAgentSessionAddress, writeAgentSessionAddress } = await import(
			"@hypeterminal/hl-react"
		);
		expect(readAgentSessionAddress("Mainnet")).toBeNull();
		writeAgentSessionAddress("Mainnet", "0x1234567890AbcdEF1234567890aBcdef12345678");
		expect(readAgentSessionAddress("Mainnet")).toBe("0x1234567890abcdef1234567890abcdef12345678");
		// env-scoped: mainnet/testnet sessions are independent
		expect(readAgentSessionAddress("Testnet")).toBeNull();
		clearAgentSessionAddress("Mainnet");
		expect(readAgentSessionAddress("Mainnet")).toBeNull();
	});

	it("ignores garbage instead of throwing", async () => {
		const { readAgentSessionAddress, writeAgentSessionAddress } = await import("@hypeterminal/hl-react");
		localStorage.setItem("hyperliquid_agent_session_Mainnet", "{not json");
		expect(readAgentSessionAddress("Mainnet")).toBeNull();
		localStorage.removeItem("hyperliquid_agent_session_Mainnet");
		writeAgentSessionAddress("Mainnet", "nope");
		expect(readAgentSessionAddress("Mainnet")).toBeNull();
	});
});

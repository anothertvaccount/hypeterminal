// @vitest-environment jsdom

import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ConnectorMessage = { type?: string; data?: unknown };

const testState = vi.hoisted(() => ({
	activateWalletConnectPairing: vi.fn(),
	connectAsync: vi.fn(),
	isMobile: false,
	jsQrDecode: vi.fn(),
	reconnect: vi.fn(),
	pairWalletConnectUri: vi.fn(),
	walletConnectHandler: null as ((message: ConnectorMessage) => void) | null,
}));

function renderChildren(children: ReactNode) {
	return createElement(Fragment, null, children);
}

function Icon({ className }: { className?: string }) {
	return createElement("span", { className, "aria-hidden": true });
}

vi.mock("@lingui/react/macro", () => ({
	Trans: ({ children }: { children: ReactNode }) => renderChildren(children),
}));

vi.mock("@lingui/core/macro", () => ({
	t: (strings: TemplateStringsArray | string, ...values: unknown[]) => {
		if (typeof strings === "string") return strings;
		return strings.reduce((message, part, index) => `${message}${part}${values[index] ?? ""}`, "");
	},
}));

vi.mock("@phosphor-icons/react", () => ({
	GithubLogoIcon: Icon,
	ArrowSquareOutIcon: Icon,
	CaretDownIcon: Icon,
	CopyIcon: Icon,
	DeviceMobileIcon: Icon,
	FlaskIcon: Icon,
	LinkIcon: Icon,
	QrCodeIcon: Icon,
	SpinnerGapIcon: Icon,
	WalletIcon: Icon,
	WarningCircleIcon: Icon,
	XIcon: Icon,
}));

vi.mock("@hypeterminal/ui", () => ({
	Button: ({
		children,
		disabled,
		onClick,
		type,
	}: {
		children: ReactNode;
		disabled?: boolean;
		onClick?: () => void;
		type?: "button" | "submit" | "reset";
	}) => createElement("button", { disabled, onClick, type: type ?? "button" }, children),
	Drawer: ({ children, open }: { children: ReactNode; open: boolean }) =>
		open ? createElement("div", { role: "dialog" }, children) : null,
	DrawerContent: ({ children }: { children: ReactNode }) => renderChildren(children),
	Modal: ({ children, open }: { children: ReactNode; open: boolean }) =>
		open ? createElement("div", { role: "dialog" }, children) : null,
	ModalContent: ({ children }: { children: ReactNode }) => renderChildren(children),
	ModalPopup: ({ children }: { children: ReactNode }) => renderChildren(children),
	TextInput: ({
		label,
		onChange,
		value,
		...props
	}: {
		label: ReactNode;
		onChange?: (event: { target: { value: string } }) => void;
		value?: string;
		[key: string]: unknown;
	}) =>
		createElement(
			"label",
			null,
			label,
			createElement("input", {
				...props,
				onChange: (event) => onChange?.({ target: { value: event.currentTarget.value } }),
				value: value ?? "",
			}),
		),
}));

vi.mock("@/config/wagmi", () => ({
	MOCK_WALLETS: [],
}));

vi.mock("@/hooks/use-mobile", () => ({
	useIsMobile: () => testState.isMobile,
}));

vi.mock("wagmi", () => ({
	useConnect: () => ({
		error: null,
		isPending: false,
		mutateAsync: testState.connectAsync,
	}),
	useReconnect: () => ({ reconnect: testState.reconnect }),
	useConnectors: () => [
		{ id: "coinbaseWallet", name: "Coinbase Wallet", type: "coinbaseWallet", uid: "coinbase" },
		{
			id: "walletConnect",
			name: "WalletConnect",
			type: "walletConnect",
			uid: "wallet-connect",
			emitter: {
				on: (_eventName: "message", handler: (message: ConnectorMessage) => void) => {
					testState.walletConnectHandler = handler;
				},
				off: (_eventName: "message", handler: (message: ConnectorMessage) => void) => {
					if (testState.walletConnectHandler === handler) testState.walletConnectHandler = null;
				},
			},
			getProvider: vi.fn(async () => ({
				signer: {
					client: {
						core: {
							pairing: {
								activate: testState.activateWalletConnectPairing,
							},
						},
						pair: testState.pairWalletConnectUri,
					},
				},
			})),
		},
		{ id: "mock", name: "Mock Wallet", type: "mock", uid: "mock" },
	],
}));

vi.mock("qrcode", () => ({
	toDataURL: vi.fn(async () => "data:image/png;base64,qr"),
}));

vi.mock("jsqr", () => ({
	default: testState.jsQrDecode,
}));

vi.mock("wagmi/connectors", () => ({
	mock: ({ accounts }: { accounts: readonly string[] }) => ({
		id: "mock",
		name: "Custom Mock Wallet",
		type: "mock",
		uid: `custom-${accounts[0] ?? "wallet"}`,
	}),
}));

function mockCamera() {
	const stopTrack = vi.fn();
	const getUserMedia = vi.fn(async () => ({
		getTracks: () => [{ stop: stopTrack }],
	}));

	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { getUserMedia },
	});
	Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
		configurable: true,
		writable: true,
		value: null,
	});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
	vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) =>
		window.setTimeout(() => callback(performance.now()), 0),
	);
	vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => window.clearTimeout(handle));

	return { getUserMedia, stopTrack };
}

async function flushAsyncWork(times = 4) {
	for (let i = 0; i < times; i += 1) {
		await act(async () => {
			await new Promise((resolve) => window.setTimeout(resolve, 0));
		});
	}
}

function mockBarcodeDetector(detect: () => Promise<Array<{ rawValue?: string }>>) {
	class BarcodeDetectorMock {
		async detect() {
			return detect();
		}
	}
	vi.stubGlobal("BarcodeDetector", BarcodeDetectorMock);
	Object.defineProperty(window, "BarcodeDetector", {
		configurable: true,
		value: BarcodeDetectorMock,
	});
}

function mockCanvasQrFrame() {
	Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
		configurable: true,
		get: () => 96,
	});
	Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
		configurable: true,
		get: () => 96,
	});
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		drawImage: vi.fn(),
		getImageData: vi.fn(() => ({
			data: new Uint8ClampedArray(96 * 96 * 4),
		})),
	} as unknown as CanvasRenderingContext2D);
}

function hasAlertText(container: HTMLElement, text: string) {
	return [...container.querySelectorAll('[role="alert"]')].some((alert) => alert.textContent?.includes(text));
}

describe("WalletModal", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		testState.isMobile = false;
		testState.walletConnectHandler = null;
		testState.activateWalletConnectPairing.mockReset();
		testState.activateWalletConnectPairing.mockResolvedValue(undefined);
		testState.jsQrDecode.mockReset();
		testState.jsQrDecode.mockReturnValue(null);
		testState.pairWalletConnectUri.mockReset();
		testState.pairWalletConnectUri.mockResolvedValue(undefined);
		testState.connectAsync.mockReset();
		testState.connectAsync.mockResolvedValue(undefined);
		vi.stubGlobal("localStorage", {
			getItem: vi.fn(() => null),
			setItem: vi.fn(),
			removeItem: vi.fn(),
		});
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.clearAllMocks();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		Reflect.deleteProperty(window, "BarcodeDetector");
		Reflect.deleteProperty(HTMLVideoElement.prototype, "videoWidth");
		Reflect.deleteProperty(HTMLVideoElement.prototype, "videoHeight");
	});

	it("renders connector groups without crashing", async () => {
		const { WalletModal } = await import("@/components/trade/components/wallet-modal");

		act(() => {
			root.render(createElement(WalletModal, { open: true, onOpenChange: vi.fn() }));
		});

		expect(container.textContent).toContain("Coinbase Wallet");
		expect(container.textContent).toContain("WalletConnect");
		expect(container.textContent).toContain("Mock Wallet");
	});

	it("offers a Reconnect rescue when a WalletConnect pairing was left pending (e.g. app reloaded)", async () => {
		// The shared beforeEach stubs localStorage as a no-op; use a real map here.
		const store = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: vi.fn((key: string) => store.get(key) ?? null),
			setItem: vi.fn((key: string, value: string) => void store.set(key, value)),
			removeItem: vi.fn((key: string) => void store.delete(key)),
		});
		window.localStorage.setItem("hypeterminal:wc-pairing-pending", "1");
		const { WalletModal } = await import("@/components/trade/components/wallet-modal");

		act(() => {
			root.render(createElement(WalletModal, { open: true, onOpenChange: vi.fn() }));
		});
		await flushAsyncWork();

		const rescue = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Reconnect");
		expect(rescue).toBeDefined();
		act(() => {
			rescue?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		// The rescue waits for the WalletConnect provider to be ready before it
		// re-attaches the session, so give it a tick to settle.
		await flushAsyncWork(8);
		expect(testState.reconnect).toHaveBeenCalled();
	});

	it("keeps the standard mobile WalletConnect path available alongside desktop linking", async () => {
		testState.isMobile = true;

		const { WalletModal } = await import("@/components/trade/components/wallet-modal");

		act(() => {
			root.render(createElement(WalletModal, { open: true, onOpenChange: vi.fn() }));
		});

		const buttons = [...container.querySelectorAll("button")];
		expect(buttons.some((button) => button.textContent?.includes("Link desktop wallet"))).toBe(true);
		expect(
			buttons.some(
				(button) =>
					button.textContent?.includes("WalletConnect") && !button.textContent?.includes("Link desktop wallet"),
			),
		).toBe(true);
	});

	it("shows a mobile link desktop wallet action and starts the camera scanner", async () => {
		testState.isMobile = true;
		const { getUserMedia } = mockCamera();
		mockBarcodeDetector(async () => []);

		const { WalletModal } = await import("@/components/trade/components/wallet-modal");

		act(() => {
			root.render(createElement(WalletModal, { open: true, onOpenChange: vi.fn() }));
		});

		const linkDesktopButton = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Link desktop wallet"),
		);
		expect(linkDesktopButton).toBeDefined();

		act(() => {
			linkDesktopButton?.click();
		});

		await flushAsyncWork();

		const scannerButtonLabels = [...container.querySelectorAll("button")].map((button) => button.textContent?.trim());
		expect(container.textContent).toContain("Scan WalletConnect QR");
		expect(container.textContent).not.toContain("Coinbase Wallet");
		expect(container.textContent).not.toContain("New to wallets?");
		expect(scannerButtonLabels).not.toContain("Coinbase Wallet");
		expect(scannerButtonLabels).not.toContain("WalletConnect");
		expect(scannerButtonLabels).not.toContain("Mock Wallet");
		expect(scannerButtonLabels).toContain("Back");
		expect(document.activeElement).toBe(container.querySelector('[tabindex="-1"][aria-labelledby]'));
		expect(container.querySelector('input[aria-label="Paste WalletConnect URI"]')).not.toBeNull();
		expect(getUserMedia).toHaveBeenCalledWith({
			audio: false,
			video: { facingMode: { ideal: "environment" } },
		});
		const scannerVideo = container.querySelector('video[aria-label="Desktop wallet QR scanner"]');
		expect(scannerVideo).not.toBeNull();
		expect(scannerVideo?.className).toContain("aspect-[4/3]");
	});

	it("connects a scanned WalletConnect desktop QR", async () => {
		testState.isMobile = true;
		mockCamera();
		mockBarcodeDetector(async () => [{ rawValue: "wc:abc123@2?relay-protocol=irn" }]);

		const onOpenChange = vi.fn();
		const { WalletModal } = await import("@/components/trade/components/wallet-modal");

		act(() => {
			root.render(createElement(WalletModal, { open: true, onOpenChange }));
		});

		const linkDesktopButton = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Link desktop wallet"),
		);
		expect(linkDesktopButton).toBeDefined();

		act(() => {
			linkDesktopButton?.click();
		});

		await flushAsyncWork(8);

		expect(testState.pairWalletConnectUri).toHaveBeenCalledWith({
			activatePairing: true,
			uri: "wc:abc123@2?relay-protocol=irn",
		});
		expect(testState.activateWalletConnectPairing).toHaveBeenCalledWith({
			topic: "abc123",
		});
		expect(testState.connectAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				connector: expect.objectContaining({ id: "walletConnect" }),
				pairingTopic: "abc123",
			}),
		);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("connects a manually pasted WalletConnect URI from scanner mode", async () => {
		testState.isMobile = true;
		mockCamera();
		mockBarcodeDetector(async () => []);

		const onOpenChange = vi.fn();
		const { WalletModal } = await import("@/components/trade/components/wallet-modal");

		act(() => {
			root.render(createElement(WalletModal, { open: true, onOpenChange }));
		});

		const linkDesktopButton = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Link desktop wallet"),
		);
		act(() => {
			linkDesktopButton?.click();
		});
		await flushAsyncWork();

		const manualUriInput = container.querySelector(
			'input[aria-label="Paste WalletConnect URI"]',
		) as HTMLInputElement | null;
		expect(manualUriInput).not.toBeNull();
		act(() => {
			if (manualUriInput) {
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
					manualUriInput,
					"wc:manual@2?relay-protocol=irn",
				);
				manualUriInput.dispatchEvent(new Event("input", { bubbles: true }));
			}
		});
		await flushAsyncWork();

		act(() => {
			manualUriInput?.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		await flushAsyncWork(8);

		expect(testState.pairWalletConnectUri).toHaveBeenCalledWith({
			activatePairing: true,
			uri: "wc:manual@2?relay-protocol=irn",
		});
		expect(testState.activateWalletConnectPairing).toHaveBeenCalledWith({
			topic: "manual",
		});
		expect(testState.connectAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				connector: expect.objectContaining({ id: "walletConnect" }),
				pairingTopic: "manual",
			}),
		);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("shows wrong-QR feedback for manually pasted non-WalletConnect values without connecting", async () => {
		testState.isMobile = true;
		mockCamera();
		mockBarcodeDetector(async () => []);

		const { WalletModal } = await import("@/components/trade/components/wallet-modal");

		act(() => {
			root.render(createElement(WalletModal, { open: true, onOpenChange: vi.fn() }));
		});

		const linkDesktopButton = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Link desktop wallet"),
		);
		act(() => {
			linkDesktopButton?.click();
		});
		await flushAsyncWork();

		const manualUriInput = container.querySelector(
			'input[aria-label="Paste WalletConnect URI"]',
		) as HTMLInputElement | null;
		expect(manualUriInput).not.toBeNull();
		act(() => {
			if (manualUriInput) {
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
					manualUriInput,
					"https://app.hypeterminal.com/mobile-agent-sync#ht-mobile-sync=payload",
				);
				manualUriInput.dispatchEvent(new Event("input", { bubbles: true }));
			}
		});
		await flushAsyncWork();

		act(() => {
			manualUriInput?.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		await flushAsyncWork();

		expect(container.textContent).toContain("This is a phone-access QR.");
		expect(hasAlertText(container, "This is a phone-access QR.")).toBe(true);
		expect(testState.pairWalletConnectUri).not.toHaveBeenCalled();
		expect(testState.connectAsync).not.toHaveBeenCalled();

		act(() => {
			if (manualUriInput) {
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
					manualUriInput,
					"https://example.com/not-walletconnect",
				);
				manualUriInput.dispatchEvent(new Event("input", { bubbles: true }));
			}
		});
		await flushAsyncWork();

		act(() => {
			manualUriInput?.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		await flushAsyncWork();

		expect(container.textContent).toContain("This is not a WalletConnect QR code.");
		expect(hasAlertText(container, "This is not a WalletConnect QR code.")).toBe(true);
		expect(testState.pairWalletConnectUri).not.toHaveBeenCalled();
		expect(testState.connectAsync).not.toHaveBeenCalled();
	});

	it("falls back to jsqr when BarcodeDetector is unavailable", async () => {
		testState.isMobile = true;
		mockCamera();
		mockCanvasQrFrame();
		testState.jsQrDecode.mockReturnValue({ data: "wc:fallback@2?relay-protocol=irn" });

		const { WalletModal } = await import("@/components/trade/components/wallet-modal");

		act(() => {
			root.render(createElement(WalletModal, { open: true, onOpenChange: vi.fn() }));
		});

		const linkDesktopButton = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Link desktop wallet"),
		);
		act(() => {
			linkDesktopButton?.click();
		});

		await flushAsyncWork(10);

		expect(testState.jsQrDecode).toHaveBeenCalled();
		expect(testState.pairWalletConnectUri).toHaveBeenCalledWith({
			activatePairing: true,
			uri: "wc:fallback@2?relay-protocol=irn",
		});
		expect(testState.connectAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				pairingTopic: "fallback",
			}),
		);
	});

	it("does not connect if QR detection resolves after the scanner is cancelled", async () => {
		testState.isMobile = true;
		const { stopTrack } = mockCamera();
		let resolveDetect: ((codes: Array<{ rawValue?: string }>) => void) | null = null;
		const detectStarted = vi.fn();
		mockBarcodeDetector(
			() =>
				new Promise((resolve) => {
					detectStarted();
					resolveDetect = resolve;
				}),
		);

		const { WalletModal } = await import("@/components/trade/components/wallet-modal");

		act(() => {
			root.render(createElement(WalletModal, { open: true, onOpenChange: vi.fn() }));
		});

		const linkDesktopButton = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Link desktop wallet"),
		);
		expect(linkDesktopButton).toBeDefined();

		act(() => {
			linkDesktopButton?.click();
		});

		await flushAsyncWork(6);
		expect(detectStarted).toHaveBeenCalled();

		const cancelButton = [...container.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Back",
		);
		expect(cancelButton).toBeDefined();

		act(() => {
			cancelButton?.click();
		});
		await flushAsyncWork();
		expect(stopTrack).toHaveBeenCalled();

		await act(async () => {
			resolveDetect?.([{ rawValue: "wc:late@2?relay-protocol=irn" }]);
			await new Promise((resolve) => window.setTimeout(resolve, 0));
		});
		await flushAsyncWork();

		expect(testState.pairWalletConnectUri).not.toHaveBeenCalled();
		expect(testState.connectAsync).not.toHaveBeenCalled();
	});

	it("shows wrong-QR feedback for phone-access and unsupported values without connecting", async () => {
		testState.isMobile = true;
		mockCamera();
		mockBarcodeDetector(async () => [
			{
				rawValue: "https://app.hypeterminal.com/mobile-agent-sync#ht-mobile-sync=payload",
			},
		]);

		const { WalletModal } = await import("@/components/trade/components/wallet-modal");

		act(() => {
			root.render(createElement(WalletModal, { open: true, onOpenChange: vi.fn() }));
		});

		const linkDesktopButton = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Link desktop wallet"),
		);
		expect(linkDesktopButton).toBeDefined();

		act(() => {
			linkDesktopButton?.click();
		});

		await flushAsyncWork(8);

		expect(container.textContent).toContain("This is a phone-access QR.");
		expect(hasAlertText(container, "This is a phone-access QR.")).toBe(true);
		expect(testState.pairWalletConnectUri).not.toHaveBeenCalled();
		expect(testState.connectAsync).not.toHaveBeenCalled();
	});

	it("shows wrong-QR feedback for unsupported scanner values without connecting", async () => {
		testState.isMobile = true;
		mockCamera();
		mockBarcodeDetector(async () => [{ rawValue: "https://example.com/not-walletconnect" }]);

		const { WalletModal } = await import("@/components/trade/components/wallet-modal");

		act(() => {
			root.render(createElement(WalletModal, { open: true, onOpenChange: vi.fn() }));
		});

		const linkDesktopButton = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Link desktop wallet"),
		);
		expect(linkDesktopButton).toBeDefined();

		act(() => {
			linkDesktopButton?.click();
		});

		await flushAsyncWork(8);

		expect(container.textContent).toContain("This is not a WalletConnect QR code.");
		expect(hasAlertText(container, "This is not a WalletConnect QR code.")).toBe(true);
		expect(testState.pairWalletConnectUri).not.toHaveBeenCalled();
		expect(testState.connectAsync).not.toHaveBeenCalled();
	});

	it("shows camera fallback messages when camera access is unavailable or denied", async () => {
		testState.isMobile = true;
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: undefined,
		});
		const { WalletModal } = await import("@/components/trade/components/wallet-modal");

		act(() => {
			root.render(createElement(WalletModal, { open: true, onOpenChange: vi.fn() }));
		});

		const linkDesktopButton = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Link desktop wallet"),
		);
		act(() => {
			linkDesktopButton?.click();
		});
		await flushAsyncWork();

		expect(container.textContent).toContain("Camera access is not available in this browser.");
		expect(hasAlertText(container, "Camera access is not available in this browser.")).toBe(true);
		expect(container.querySelector('input[aria-label="Paste WalletConnect URI"]')).not.toBeNull();

		act(() => root.unmount());
		root = createRoot(container);

		const getUserMedia = vi.fn(async () => {
			throw new DOMException("denied", "NotAllowedError");
		});
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: { getUserMedia },
		});
		act(() => {
			root.render(createElement(WalletModal, { open: true, onOpenChange: vi.fn() }));
		});
		await flushAsyncWork();

		const linkDesktopButtonAfterRerender = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Link desktop wallet"),
		);
		act(() => {
			linkDesktopButtonAfterRerender?.click();
		});
		await flushAsyncWork();

		expect(container.textContent).toContain("Camera permission was denied.");
		expect(hasAlertText(container, "Camera permission was denied.")).toBe(true);
		expect(container.querySelector('input[aria-label="Paste WalletConnect URI"]')).not.toBeNull();
	});

	it("stops camera tracks when the modal closes during scanner mode", async () => {
		testState.isMobile = true;
		const { stopTrack } = mockCamera();
		mockBarcodeDetector(async () => []);
		const { WalletModal } = await import("@/components/trade/components/wallet-modal");

		act(() => {
			root.render(createElement(WalletModal, { open: true, onOpenChange: vi.fn() }));
		});

		const linkDesktopButton = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Link desktop wallet"),
		);
		act(() => {
			linkDesktopButton?.click();
		});
		await flushAsyncWork();

		act(() => {
			root.render(createElement(WalletModal, { open: false, onOpenChange: vi.fn() }));
		});
		await flushAsyncWork();

		expect(stopTrack).toHaveBeenCalled();
	});
});

import { FlaskIcon, WalletIcon } from "@phosphor-icons/react";
import { CoinbaseIcon } from "@/components/icons/coinbase-icon";
import { MetaMaskIcon } from "@/components/icons/metamask-icon";
import { RabbyIcon } from "@/components/icons/rabby-icon";
import { WalletConnectIcon } from "@/components/icons/walletconnect-icon";

export interface WalletInfo {
	icon: React.ComponentType<{ className?: string }>;
	description: string;
	popular?: boolean;
	priority?: number;
	/**
	 * App/universal link that opens this wallet. WalletConnect sessions never
	 * auto-foreground the wallet for a pending signature, so the UI offers a
	 * one-tap "open the wallet app" instead of leaving people to switch by hand.
	 */
	deepLink?: string;
}

const rabby: WalletInfo = {
	icon: RabbyIcon,
	deepLink: "https://rabby.io",
	description: "Multi-chain wallet with pre-sign checks",
	popular: true,
	priority: 1,
};

const metaMask: WalletInfo = {
	icon: MetaMaskIcon,
	deepLink: "https://metamask.app.link",
	description: "The most popular crypto wallet",
	popular: true,
	priority: 2,
};

const coinbase: WalletInfo = {
	icon: CoinbaseIcon,
	deepLink: "https://go.cb-w.com/dapp",
	description: "Easy to use mobile & browser wallet",
	popular: true,
	priority: 3,
};

const walletConnect: WalletInfo = {
	icon: WalletConnectIcon,
	// While pairing, the app is opened through the live `wc:` URI instead.
	deepLink: "https://walletconnect.com",
	description: "Scan QR code with your mobile wallet",
	popular: true,
	priority: 4,
};

const injected: WalletInfo = {
	icon: WalletIcon,
	description: "Use your browser's built-in wallet",
	popular: false,
	priority: 10,
};

const mock: WalletInfo = {
	icon: FlaskIcon,
	description: "Mock wallet for testing",
	popular: false,
	priority: 0,
};

export const WALLET_INFO: Record<string, WalletInfo> = {
	"io.rabby": rabby,
	"Rabby Wallet": rabby,
	Rabby: rabby,
	metaMask,
	MetaMask: metaMask,
	coinbaseWallet: coinbase,
	"Coinbase Wallet": coinbase,
	walletConnect,
	WalletConnect: walletConnect,
	injected,
	Injected: injected,
	"Browser Wallet": injected,
	mock,
	Mock: mock,
};

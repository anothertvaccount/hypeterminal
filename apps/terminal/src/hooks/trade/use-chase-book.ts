import { type L2BookWsEvent, SubscriptionClient, WebSocketTransport } from "@nktkas/hyperliquid";
import { useEffect, useState } from "react";
import { isTestnet } from "@/lib/network";

/** The SDK filters books by coin only, so grouped UI books need a separate socket. */
export function useChaseBook(coin: string | undefined): L2BookWsEvent | undefined {
	const [book, setBook] = useState<L2BookWsEvent>();
	const testnet = isTestnet();
	useEffect(() => {
		setBook(undefined);
		if (!coin) return;
		const transport = new WebSocketTransport({
			isTestnet: testnet,
			reconnect: { maxRetries: Infinity, connectionTimeout: 10_000 },
		});
		const client = new SubscriptionClient({ transport });
		let disposed = false;
		let retry: ReturnType<typeof setTimeout> | undefined;
		const clearBook = () => {
			if (!disposed) setBook(undefined);
		};
		transport.socket.addEventListener("close", clearBook);
		const subscribe = () => {
			void client
				.l2Book({ coin }, (event) => {
					if (!disposed) setBook(event);
				})
				.then((subscription) => {
					if (disposed) return;
					subscription.failureSignal.addEventListener(
						"abort",
						() => {
							if (disposed) return;
							clearBook();
							retry = setTimeout(subscribe, 1_000);
						},
						{ once: true },
					);
				})
				.catch(() => {
					if (disposed) return;
					clearBook();
					retry = setTimeout(subscribe, 1_000);
				});
		};
		subscribe();
		return () => {
			disposed = true;
			clearTimeout(retry);
			transport.socket.removeEventListener("close", clearBook);
			void transport.close().catch(() => {});
		};
	}, [coin, testnet]);
	return book?.coin === coin ? book : undefined;
}

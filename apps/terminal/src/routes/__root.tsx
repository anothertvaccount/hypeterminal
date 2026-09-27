import type { QueryClient } from "@tanstack/react-query";
import { ClientOnly, createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { Suspense, useEffect } from "react";
import { NotFoundPage } from "@/components/pages/not-found-page";
import { AppShellSkeleton } from "@/components/trade/layout/app-shell-skeleton";
import { MarketsInfoProvider } from "@/lib/hyperliquid/hooks/MarketsInfoProvider";
import { createLazyComponent } from "@/lib/lazy";
import { buildPageHead, mergeHead } from "@/lib/seo";
import { ExchangeScopeProvider } from "@/providers/exchange-scope";
import "@/bones/registry";
import appCss from "../styles.css?url";

const Toaster = createLazyComponent(() => import("@/components/ui/sonner"), "Toaster");

interface MyRouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
	head: () => {
		const seoHead = buildPageHead();
		return mergeHead(seoHead, {
			links: [{ rel: "stylesheet", href: appCss }],
		});
	},
	shellComponent: RootDocument,
	component: RootComponent,
	notFoundComponent: NotFoundPage,
});

function RootComponent() {
	useEffect(() => {
		if ("serviceWorker" in navigator) {
			// BASE_URL follows vite's base so the worker registers under subpath
			// deploys (/terminal/sw.js scoped to /terminal/) and at the root otherwise.
			navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
				scope: import.meta.env.BASE_URL,
			});
		}
	}, []);

	return (
		<ClientOnly fallback={<AppShellSkeleton />}>
			<ExchangeScopeProvider>
				<MarketsInfoProvider>
					<Outlet />
					<Suspense fallback={null}>
						<Toaster />
					</Suspense>
				</MarketsInfoProvider>
			</ExchangeScopeProvider>
		</ClientOnly>
	);
}

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<HeadContent />
			</head>
			<body>
				{children}
				<Scripts />
			</body>
		</html>
	);
}

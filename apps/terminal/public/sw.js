const CACHE_VERSION = "v1";
const CHARTING_CACHE = `charting-${CACHE_VERSION}`;
const FONT_CACHE = `fonts-${CACHE_VERSION}`;
const ICON_CACHE = `icons-${CACHE_VERSION}`;
const NAV_CACHE = `nav-${CACHE_VERSION}`;

const MAX_ICON_ENTRIES = 500;
const MAX_ICON_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// App-shell (navigations) must be FRESH: the shell points at the hashed JS bundle, so a
// stale shell silently boots the whole previous build. 3s was short enough that a
// phone on a slow connection kept getting the cached old app ("no change" after a
// deploy). Give the network a real window, and refresh the cache in the background
// when we do fall back to it.
const NAV_TIMEOUT_MS = 8000;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter(
							(k) =>
								![CHARTING_CACHE, FONT_CACHE, ICON_CACHE, NAV_CACHE].includes(k),
						)
						.map((k) => caches.delete(k)),
				),
			)
			// Take over pages that are already open, so an updated worker applies
			// immediately instead of on the next cold start.
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const { request } = event;
	const url = new URL(request.url);

	if (request.method !== "GET") return;

	// includes() so the rule also matches under subpath deploys
	// (https://host/terminal/charting_library/...) — startsWith only fit the root.
	if (url.pathname.includes("/charting_library/")) {
		event.respondWith(cacheFirst(request, CHARTING_CACHE));
		return;
	}

	if (request.destination === "font") {
		event.respondWith(cacheFirst(request, FONT_CACHE));
		return;
	}

	if (
		url.hostname === "app.hyperliquid.xyz" &&
		url.pathname.startsWith("/coins/")
	) {
		event.respondWith(staleWhileRevalidate(request, ICON_CACHE));
		return;
	}

	if (request.mode === "navigate") {
		event.respondWith(networkFirst(request, NAV_CACHE, NAV_TIMEOUT_MS));
		return;
	}
});

async function cacheFirst(request, cacheName) {
	const cached = await caches.match(request);
	if (cached) return cached;
	const response = await fetch(request);
	if (response.ok) {
		const cache = await caches.open(cacheName);
		cache.put(request, response.clone());
	}
	return response;
}

async function staleWhileRevalidate(request, cacheName) {
	const cache = await caches.open(cacheName);
	const cached = await cache.match(request);
	const fetched = fetch(request).then((response) => {
		if (response.ok) {
			cache.put(request, response.clone());
			evictOldEntries(cache, MAX_ICON_ENTRIES);
		}
		return response;
	});
	return cached || fetched;
}

async function networkFirst(request, cacheName, timeoutMs) {
	const cache = await caches.open(cacheName);
	try {
		const response = await promiseWithTimeout(fetch(request), timeoutMs);
		if (response.ok) cache.put(request, response.clone());
		return response;
	} catch {
		const cached = await cache.match(request);
		if (cached) {
			// Serve immediately, but pull the fresh shell in the background so the
			// next open is current instead of staying a version behind.
			fetch(request)
				.then((response) => {
					if (response.ok) cache.put(request, response.clone());
				})
				.catch(() => undefined);
		}
		return cached || new Response("Offline", { status: 503 });
	}
}

function promiseWithTimeout(promise, ms) {
	return Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
	]);
}

async function evictOldEntries(cache, maxEntries) {
	const keys = await cache.keys();
	if (keys.length > maxEntries) {
		await cache.delete(keys[0]);
	}
}

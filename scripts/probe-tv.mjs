import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pnpmRoot = path.join(process.cwd(), "node_modules", ".pnpm");
const entry = readdirSync(pnpmRoot).find((name) => name.startsWith("playwright@"));
const playwright = await import(
	pathToFileURL(path.join(pnpmRoot, entry, "node_modules", "playwright", "index.js")).href
);
const { chromium } = playwright.default ?? playwright;

function findChromium() {
	const msRoot = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "ms-playwright") : "";
	try {
		const builds = readdirSync(msRoot)
			.filter((name) => name.startsWith("chromium-") && !name.includes("headless"))
			.sort()
			.reverse();
		for (const build of builds) {
			const candidate = path.join(msRoot, build, "chrome-win", "chrome.exe");
			try {
				if (readdirSync(path.dirname(candidate)).includes("chrome.exe")) return candidate;
			} catch {}
		}
	} catch {}
	return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
}

const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
try {
	await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => Boolean(globalThis.__hlOrderEntry), null, { timeout: 30000 });
	await page.waitForTimeout(3000);
	await page.getByRole("button", { name: "TradingView", exact: true }).first().click();
	await page.waitForFunction(() => Boolean(globalThis.__hlTvWidget), null, { timeout: 30000 });
	await page.waitForTimeout(4000);

	await page.evaluate(() => {
		const chart = globalThis.__hlTvWidget.activeChart();
		globalThis.__hlCross = null;
		chart.crossHairMoved().subscribe(null, (e) => {
			globalThis.__hlCross = { price: e?.price, offsetX: e?.offsetX, offsetY: e?.offsetY, time: e?.time };
		});
	});

	// Identify plot / left toolbar / right axis DOM by walking from probe points.
	const chains = await page.evaluate(() => {
		const probe = (x, y) => {
			const el = document.elementFromPoint(x, y);
			const out = [];
			let node = el;
			while (node && out.length < 10) {
				out.push({
					tag: node.tagName,
					cls: String(node.className ?? "").slice(0, 100),
					rect: (() => {
						const r = node.getBoundingClientRect();
						return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
					})(),
				});
				node = node.parentElement;
			}
			return out;
		};
		return { plot: probe(400, 420), left: probe(10, 420), right: probe(1465, 420) };
	});
	console.log("PLOT:", JSON.stringify(chains.plot.slice(0, 6), null, 1));
	console.log("LEFT:", JSON.stringify(chains.left.slice(0, 5), null, 1));
	console.log("RIGHT:", JSON.stringify(chains.right.slice(0, 6), null, 1));

	// Numeric leaf labels with rects → price-axis label cluster + linear fit samples.
	const labels = await page.evaluate(() => {
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		return [...document.querySelectorAll("*")]
			.filter((el) => el.children.length === 0 && /^[\d,.]+$/.test((el.textContent ?? "").trim()))
			.map((el) => {
				const r = el.getBoundingClientRect();
				return {
					text: el.textContent.trim(),
					cls: String(el.className).slice(0, 70),
					x: Math.round(r.left),
					y: Math.round(r.top + r.height / 2),
					w: Math.round(r.width),
				};
			})
			.filter((l) => l.w > 10 && l.x > vw * 0.4 && l.y > 100 && l.y < vh - 100)
			.slice(0, 40);
	});
	console.log("LABELS:", JSON.stringify(labels, null, 1));

	// Crosshair pairing: pointer clientXY vs offsetX/offsetY (container space?).
	await page.mouse.move(400, 300, { steps: 6 });
	await page.waitForTimeout(300);
	await page.mouse.move(400, 500, { steps: 6 });
	await page.waitForTimeout(400);
	const cross = await page.evaluate(() => globalThis.__hlCross);
	console.log("CROSS:", JSON.stringify(cross));
	const contRect = await page.evaluate(() => {
		const w = globalThis.__hlTvWidget;
		// The widget container: our app passes container div; find it as the common ancestor
		// of the plot chain — fallback: element at plot with id/data attrs.
		const el = document.elementFromPoint(400, 420);
		let host = el;
		while (host && !(host.id || String(host.dataset?.tvContainer ?? "") || host.classList.contains("relative"))) {
			host = host.parentElement;
		}
		const r = (host ?? document.body).getBoundingClientRect();
		return { cls: String(host?.className ?? "").slice(0, 80), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
	});
	console.log("CONTAINER:", JSON.stringify(contRect));

	const iframeFacts = await page.evaluate(() => {
		const frames = [...document.querySelectorAll("iframe")];
		const f = frames.find((fr) => {
			const r = fr.getBoundingClientRect();
			return r.width > 300 && r.height > 300;
		});
		if (!f) return { error: "no chart iframe" };
		const out = { src: f.src, rect: (() => { const r = f.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })() };
		try {
			const doc = f.contentDocument;
			out.sameOrigin = Boolean(doc);
			if (doc) {
				const rect = f.getBoundingClientRect();
				out.labels = [...doc.querySelectorAll("*")]
					.filter((el) => el.children.length === 0 && /^[\d,.]+$/.test((el.textContent ?? "").trim()))
					.map((el) => {
						const r = el.getBoundingClientRect();
						return { text: el.textContent.trim(), cls: String(el.className).slice(0, 60), x: Math.round(r.left - rect.left), y: Math.round(r.top - rect.top + r.height / 2), w: Math.round(r.width) };
					})
					.filter((l) => l.w > 10 && l.x > rect.width - 200)
					.slice(0, 25);
				const probe = (x, y) => {
					const el = doc.elementFromPoint(x, y);
					const chain = [];
					let n = el;
					while (n && chain.length < 6) { chain.push(`${n.tagName}.${String(n.className ?? "").slice(0, 70)}`); n = n.parentElement; }
					return chain;
				};
				out.iframePlot = probe(Math.round(out.rect.w * 0.4), Math.round(out.rect.h * 0.5));
				out.iframeLeft = probe(6, Math.round(out.rect.h * 0.5));
				out.iframeRight = probe(out.rect.w - 8, Math.round(out.rect.h * 0.5));
			}
		} catch (e) {
			out.sameOrigin = false;
			out.error = String(e);
		}
		return out;
	});
	console.log("IFRAME:", JSON.stringify(iframeFacts, null, 1));
	console.log("CROSS2:", JSON.stringify(await page.evaluate(() => globalThis.__hlCross)));

	// What element receives clicks over the TV header (where the Default button lives)?
	const headerHit = await page.evaluate(() => {
		const frames = [...document.querySelectorAll("iframe")].filter((f) => f.src.startsWith("blob:"));
		if (frames.length === 0) return { note: "no blob iframe" };
		const r = frames[0].getBoundingClientRect();
		const el = document.elementFromPoint(r.left + r.width - 120, r.top + 24);
		return {
			tag: el?.tagName,
			cls: String(el?.className ?? "").slice(0, 90),
			overlay: Boolean(el?.closest?.("[data-tv-overlay]")),
			axisStrip: Boolean(el?.closest?.("[data-tv-axis-strip]")),
		};
	});
	console.log("HEADER_HIT:", JSON.stringify(headerHit));

	await page.screenshot({ path: "probe-tv2.png" });
	console.log("saved probe-tv2.png");
} finally {
	await browser.close();
}

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
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("console", (m) => {
	if (m.type() === "error" || m.type() === "warning") console.log(`[${m.type()}]`, m.text().slice(0, 500));
});
page.on("pageerror", (e) => console.log("[PAGEERROR]", e.message, "\n", (e.stack ?? "").slice(0, 1500)));

try {
	await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(6000);
	const state = await page.evaluate(() => ({
		chart: !!globalThis.__hlChart,
		paper: !!globalThis.__hlPaper,
		entry: !!globalThis.__hlOrderEntry,
		hook: !!document.querySelector("form[data-order-form]"),
		viteOverlay: !!document.querySelector("vite-error-overlay"),
		bodyText: document.body.innerText.slice(0, 300),
	}));
	console.log("STATE:", JSON.stringify(state, null, 2));
} finally {
	await browser.close();
}

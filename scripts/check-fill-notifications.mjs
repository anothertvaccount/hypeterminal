import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Browser check for the fill alerts (dev server must be running):
 *   node scripts/check-fill-notifications.mjs
 *
 * Injects a crossed resting order through the dev store hook and verifies the
 * top-right popup appears in the right place, carries the fill details, auto-
 * dismisses, and that the mute toggle persists.
 */
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
			} catch {
				// continue
			}
		}
	} catch {
		// fall through
	}
	return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
}

const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

let failures = 0;
const check = (ok, message) => {
	console.log(`${ok ? "PASS" : "FAIL"}: ${message}`);
	if (!ok) failures += 1;
};
const countPopups = () => page.locator('[data-testid="fill-notification"]').count();
const inject = (order) =>
	page.evaluate((row) => {
		const store = globalThis.__hlPaper;
		const state = store.getState();
		store.setState({ openOrders: [...state.openOrders, row] });
	}, order);

try {
	await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(5000);

	check((await page.evaluate(() => !!globalThis.__hlPaper)) ?? false, "dev store hook present");
	check((await countPopups()) === 0, "no false-positive popups before any fill");

	// A buy limit far above the mark crosses immediately → engine fills on the next tick.
	await inject({
		oid: 999999101,
		assetId: 0,
		coin: "BTC",
		dex: "",
		isBuy: true,
		size: 0.5,
		limitPx: 500_000,
		reduceOnly: false,
		leverage: 10,
		marginMode: "cross",
		tif: "Gtc",
		placedAt: Date.now(),
	});

	const appeared = await page
		.waitForSelector('[data-testid="fill-notification"]', { timeout: 25_000 })
		.then(() => true)
		.catch(() => false);
	check(appeared, "popup appears after the fill");

	if (appeared) {
		const box = await page.locator('[data-testid="fill-notification"]').first().boundingBox();
		const text = await page.locator('[data-testid="fill-notification"]').first().innerText();
		check(box !== null && box.x > 700 && box.y < 400, `popup sits top-right (x=${box?.x}, y=${box?.y})`);
		check(/BUY/i.test(text) && /BTC/.test(text) && /Filled/.test(text), `popup shows the fill (${JSON.stringify(text)})`);

		// Auto-dismiss (3.5s + buffer).
		await page.waitForTimeout(4500);
		check((await countPopups()) === 0, "popup auto-dismisses");

		// Mute toggle persists.
		await page.getByRole("button", { name: "Trade sound" }).click();
		const muted = await page.evaluate(() => localStorage.getItem("hypeterminal:fill-sound-v1") === "muted");
		check(muted, "mute toggle persists to storage");

		// A second fill still pops (popup independent of sound state).
		await inject({
			oid: 999999102,
			assetId: 0,
			coin: "BTC",
			dex: "",
			isBuy: false,
			size: 1,
			limitPx: 1,
			reduceOnly: false,
			leverage: 10,
			marginMode: "cross",
			tif: "Gtc",
			placedAt: Date.now(),
		});
		const second = await page
			.waitForSelector('[data-testid="fill-notification"]', { timeout: 25_000 })
			.then(() => true)
			.catch(() => false);
		check(second, "second fill pops again while muted");
		await page.evaluate(() => localStorage.removeItem("hypeterminal:fill-sound-v1"));
	}

	check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
	console.log(failures === 0 ? "\nFILL NOTIFICATIONS CHECK PASS" : `\n${failures} CHECK(S) FAILED`);
	process.exitCode = failures === 0 ? 0 : 1;
} finally {
	await browser.close();
}

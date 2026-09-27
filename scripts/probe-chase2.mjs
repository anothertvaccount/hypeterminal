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
			} catch {
				// continue
			}
		}
	} catch {
		// fall through to the default resolution
	}
	return "C:/Program Files/Google/Chrome/Application/chrome.exe";
}
const launchOpts = { headless: true, executablePath: findChromium() };
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
page.on("console", (m) => {
	if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 160)}`);
});
try {
	await page.goto("http://localhost:3000/");
	await page.waitForSelector("form[data-order-form]", { timeout: 25000 });
	if ((await page.getByText("Connect Wallet", { exact: true }).count()) > 0) {
		await page.getByText("Connect Wallet", { exact: true }).first().click();
		await page.getByText("Mock Wallet (Testing)").click();
		await page.locator('button:has-text("Mock Wallet")').last().click();
	}
	await page.waitForTimeout(1200);
	await page.evaluate(() => {
		globalThis.__chaseTimeoutMs = 2500;
	});
	await page.evaluate(() => {
		const s = globalThis.__hlPaper;
		s.setState({ actions: { ...s.getState().actions, fillCrossedOrders: () => [] } });
		const a = globalThis.__hlOrderEntry.getState().actions;
		a.setOrderType("chaseLimit");
		a.setSide("buy");
		a.setSize("0.001");
		a.setReduceOnly(false);
		a.setTif("Alo");
		globalThis.__hlSoundLog?.splice(0);
	});
	await page.evaluate(() => document.querySelector("form[data-order-form]").requestSubmit());
	await page.waitForTimeout(600);
	const t1 = await page.evaluate(() => ({
		orders: globalThis.__hlPaper.getState().openOrders.filter((o) => !o.isTrigger && o.size === 0.001).length,
		entry: globalThis.__hlChase ? globalThis.__hlChase.getState() : null,
		hist: (globalThis.__hlChase?.getState().history ?? []).map((h) => h.outcome),
	}));
	await page.waitForTimeout(3200);
	const t2 = await page.evaluate(() => ({
		orders: globalThis.__hlPaper.getState().openOrders.filter((o) => !o.isTrigger && o.size === 0.001).length,
		entryActive: Boolean(globalThis.__hlChase?.getState().entry),
		hist: (globalThis.__hlChase?.getState().history ?? []).map((h) => h.outcome),
		sound: globalThis.__hlSoundLog?.map((s) => s.type ?? s),
	}));
	console.log(JSON.stringify({ t1, t2, errors }, null, 1));
} catch (e) {
	console.log("PROBE ERR", String(e).slice(0, 300), JSON.stringify(errors.slice(-5)));
} finally {
	await browser.close();
}

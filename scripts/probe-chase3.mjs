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
	return "C:/Program Files/Google/Chrome/Application/chrome.exe";
}
const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
try {
	await page.goto("http://localhost:3000/");
	await page.waitForSelector("form[data-order-form]", { timeout: 25000 });
	if ((await page.getByText("Connect Wallet", { exact: true }).count()) > 0) {
		await page.getByText("Connect Wallet", { exact: true }).first().click();
		await page.getByText("Mock Wallet (Testing)").click();
		await page.locator('button:has-text("Mock Wallet")').last().click();
	}
	await page.waitForTimeout(1200);

	// 1) Two-chase sequence, exactly like check-hotkeys.
	await page.evaluate(() => {
		const s = globalThis.__hlPaper;
		s.setState({ actions: { ...s.getState().actions, fillCrossedOrders: () => [] } });
		globalThis.__chaseTimeoutMs = 2500;
		globalThis.__hlSoundLog?.splice(0);
		const a = globalThis.__hlOrderEntry.getState().actions;
		a.setOrderType("chaseLimit");
		a.setSide("buy");
		a.setSize("0.001");
		a.setReduceOnly(false);
		a.setTif("Alo");
	});
	await page.evaluate(() => document.querySelector("form[data-order-form]").requestSubmit());
	await page.waitForTimeout(700);
	const seq1 = await page.evaluate(() => ({
		orders: globalThis.__hlPaper.getState().openOrders.filter((o) => !o.isTrigger && o.size === 0.001).length,
		entry: globalThis.__hlChase.getState().entry ?? null,
	}));
	await page.evaluate(() => {
		const a = globalThis.__hlOrderEntry.getState().actions;
		a.setSide("sell");
		a.setSize("0.001");
		a.setReduceOnly(true);
	});
	await page.evaluate(() => document.querySelector("form[data-order-form]").requestSubmit());
	await page.waitForTimeout(600);
	const seq2 = await page.evaluate(() => ({
		orders: globalThis.__hlPaper.getState().openOrders.filter((o) => !o.isTrigger && o.size === 0.001).length,
		entry: globalThis.__hlChase.getState().entry ?? null,
		hist: (globalThis.__hlChase.getState().history ?? []).map((h) => h.outcome),
	}));
	await page.waitForTimeout(3200);
	const seq3 = await page.evaluate(() => ({
		orders: globalThis.__hlPaper.getState().openOrders.filter((o) => !o.isTrigger && o.size === 0.001).length,
		entryActive: Boolean(globalThis.__hlChase.getState().entry),
		hist: (globalThis.__hlChase.getState().history ?? []).map((h) => h.outcome),
		sound: (globalThis.__hlSoundLog ?? []).map((s) => s.type ?? s),
	}));
	console.log("SEQ", JSON.stringify({ seq1, seq2, seq3 }, null, 1));

	// 2) Positions row dropdown: does the trigger render, and is it visible?
	await page.evaluate(() => {
		globalThis.__hlPaper.setState({
			positions: [
				{ assetId: 0, coin: "BTC", dex: "", szi: 0.02, entryPx: 85000, leverage: 10, marginMode: "cross" },
			],
		});
	});
	await page.waitForTimeout(800);
	await page.getByRole("tab", { name: "Positions" }).click();
	await page.waitForTimeout(500);
	const rows = await page.evaluate(() =>
		[...document.querySelectorAll("tr,div")].filter((el) => el.textContent?.includes("0.0200")).length,
	);
	const trig = page.getByRole("button", { name: "Position close actions" });
	const trigCount = await trig.count();
	let trigVisible = false;
	if (trigCount > 0) trigVisible = await trig.first().isVisible();
	let hoverOK = false;
	try {
		await page.getByText("0.0200").first().hover({ timeout: 4000 });
		await page.waitForTimeout(400);
		hoverOK = trigCount > 0 ? await trig.first().isVisible() : false;
	} catch (e) {
		hoverOK = `hovererr:${String(e).slice(0, 80)}`;
	}
	console.log("ROWS", JSON.stringify({ rows, trigCount, trigVisible, hoverOK, errors }));
} catch (e) {
	console.log("PROBE ERR", String(e).slice(0, 300), JSON.stringify(errors.slice(-4)));
} finally {
	await browser.close();
}

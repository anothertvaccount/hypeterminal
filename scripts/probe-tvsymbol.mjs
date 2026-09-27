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
const logs = [];
page.on("console", (m) => {
	const t = m.text();
	if (/error|fail|resolve|symbol/i.test(t)) logs.push(`${m.type()}: ${t.slice(0, 160)}`);
});
page.on("pageerror", (e) => logs.push(`pageerror: ${String(e).slice(0, 160)}`));
try {
	await page.goto("http://localhost:3000/");
	await page.waitForFunction(() => Boolean(globalThis.__hlTvWidget), null, { timeout: 25000 });
	await page.waitForTimeout(4000);
	// Seed a persisted state first (the user's distinguishing condition), then
	// reload so the next boot restores indicators like theirs does.
	const seeded = await page.evaluate(
		() =>
			new Promise((res) => {
				globalThis.__hlTvWidget.save((s) => {
					localStorage.setItem("tv-chart-v1", JSON.stringify(s));
					res({ keys: Object.keys(s ?? {}).length });
				});
			}),
	);
	console.log("SEEDED state:", JSON.stringify(seeded));
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => Boolean(globalThis.__hlTvWidget), null, { timeout: 25000 });
	await page.waitForTimeout(4500);
	const before = await page.evaluate(() => ({
		symbol: globalThis.__hlTvWidget.activeChart().symbol(),
		hasState: Boolean(localStorage.getItem("tv-chart-v1")),
	}));
	console.log("BEFORE:", JSON.stringify(before));
	await page.evaluate(() => {
		globalThis.__tvBefore = globalThis.__hlTvWidget;
	});

	// Switch through the app's REAL market UI (ticker strip / market list).
	const eth = page.getByText("ETH-USDC", { exact: true });
	const ethCount = await eth.count();
	console.log("ETH-USDC matches:", ethCount);
	if (ethCount === 0) throw new Error("no ETH entry found");
	await eth.first().click();
	await page.waitForTimeout(4000); // widget dispose + rebuild + resolve

	const after = await page.evaluate(() => ({
		symbol: globalThis.__hlTvWidget.activeChart().symbol(),
		rebuilt: globalThis.__tvBefore !== globalThis.__hlTvWidget,
	}));
	console.log("AFTER ETH CLICK:", JSON.stringify(after));
	console.log("console noise:", JSON.stringify(logs.slice(-8), null, 1));

	// And once more with a symbol that definitely differs in the app store.
	const hype = page.getByText("HYPE-USDC", { exact: true });
	if ((await hype.count()) > 0) {
		await hype.first().click();
		await page.waitForTimeout(3500);
		const after2 = await page.evaluate(() => globalThis.__hlTvWidget.activeChart().symbol());
		console.log("AFTER HYPE CLICK:", JSON.stringify({ symbol: after2 }));
	}
} catch (e) {
	console.log("PROBE ERR", String(e).slice(0, 300));
} finally {
	await browser.close();
}

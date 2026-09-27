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
const pass = (label, ok, detail = "") => console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` (${detail})` : ""}`);
try {
	const BASE = process.argv[2] ?? "http://localhost:3100";
	await page.goto(`${BASE}/`);
	await page.waitForSelector("form[data-order-form]", { timeout: 30000 });
	await page.waitForTimeout(2500);

	// Order-type dropdown: every item must be a real word, not a hashed id.
	let trigger = page.getByRole("button", { name: "Order type" });
	if ((await trigger.count()) === 0) trigger = page.locator('form[data-order-form] button[aria-label]').first();
	await trigger.click();
	await page.waitForTimeout(400);
	const menuText = await page.evaluate(() => {
		const el = document.querySelector('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]');
		return el?.innerText ?? "";
	});
	pass(
		"order-type menu shows 'Chase Limit' (no hashed ids)",
		menuText.includes("Chase Limit") && !/\b[a-zA-Z0-9_-]{5,7}\b/.test(menuText.replace(/\b(Chase Limit|Stop Market|Stop Limit|TWAP|Scale|Market|Limit)\b/g, "")),
		menuText.replace(/\n/g, " | ").slice(0, 120),
	);
	// Select it: the trigger must show the label, not an id.
	const chaseItem = page.getByText("Chase Limit", { exact: true });
	if ((await chaseItem.count()) > 0) {
		await chaseItem.first().click();
		await page.waitForTimeout(400);
		const triggerText = await trigger.innerText().catch(() => "");
		pass("trigger shows 'Chase Limit' after selecting", triggerText.includes("Chase Limit"), JSON.stringify(triggerText));
	} else {
		pass("chase item clickable", false, "not found");
	}

	// Settings: our sections must read as English.
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.waitForTimeout(600);
	const settingsText = (await page.getByRole("dialog").innerText().catch(() => "")).toLowerCase();
	pass(
		"settings groups readable (Size buttons / Default size / Trading)",
		settingsText.includes("size buttons") && settingsText.includes("default size") && settingsText.includes("trading"),
	);
	pass("no known hashed ids on screen", !/xfHtz9|o636h-|NJNMJX|bifv6N|NZjIue/.test(settingsText));
	// crc ids are short and digit-bearing (xfHtz9, o636h-, bifv6N) — real UI words aren't.
	const suspicious = settingsText.split(/\s+/).filter((w) => /^[a-z0-9_-]{5,7}$/.test(w) && /\d/.test(w));
	pass("no hash-like tokens in settings text", suspicious.length === 0, suspicious.slice(0, 5).join(","));
} catch (e) {
	console.log("PROBE ERR", String(e).slice(0, 300));
} finally {
	await browser.close();
}

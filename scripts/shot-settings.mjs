import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Visual check: opens Settings and screenshots it for manual inspection. */
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

const outFile = process.argv[2] ?? "settings.png";
const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
try {
	await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(5000);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.waitForTimeout(600);
	await page.screenshot({ path: outFile });
	console.log(`saved ${outFile}`);
} finally {
	await browser.close();
}

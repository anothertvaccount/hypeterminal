import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Render check for /dev-builder-fees (read-only: never clicks the zero buttons). */
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

try {
	await page.goto("http://localhost:3000/dev-builder-fees", { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(3000);

	const title = await page.getByRole("heading", { name: "Builder fee approvals" }).count();
	check(title > 0, "page renders (dev route resolves)");

	const bodyText = await page.evaluate(() => document.body.innerText);
	check(bodyText.includes("Connect a wallet"), "shows the connect state before a wallet is attached");

	// Connect the dev mock wallet (read-only for approvals; never clicks zero buttons).
	await page.getByRole("button", { name: "Connect Mock Wallet" }).click();
	await page.waitForTimeout(2500);
	const after = await page.evaluate(() => document.body.innerText);
	check(
		after.includes("No builders approved") || /Max fee\s/.test(after),
		"lists approvals (or the empty state) for the connected address",
	);
	check(!after.includes("undefined"), "no undefined leaking into the UI");

	check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
	console.log(failures === 0 ? "\nBUILDER TOOL CHECK PASS" : `\n${failures} CHECK(S) FAILED`);
	process.exitCode = failures === 0 ? 0 : 1;
} finally {
	await browser.close();
}

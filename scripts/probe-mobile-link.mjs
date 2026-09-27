/** End-to-end: desktop creates a phone link → phone opens it → pairing code import. */
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
const check = (label, ok, detail = "") => console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` (${detail})` : ""}`);
const browser = await chromium.launch({ headless: true, executablePath: findChromium() });

async function mockConnect(page) {
	const exact = page.getByText("Connect Wallet", { exact: true });
	const loose = page.getByRole("button", { name: /connect wallet/i });
	const target = (await exact.count()) > 0 ? exact.first() : loose.first();
	if ((await target.count()) === 0) return;
	await target.click();
	await page.getByText("Mock Wallet (Testing)").click();
	await page.locator('button:has-text("Mock Wallet")').last().click();
	await page.waitForTimeout(900);
}
let pairingCode = null;
let phoneUrl = null;
try {
	// ---- desktop ----
	const ctxA = await browser.newContext({ viewport: { width: 1600, height: 950 }, permissions: ["clipboard-read", "clipboard-write"] });
	const page = await ctxA.newPage();
	await page.goto("http://localhost:3000/");
	await page.waitForSelector("form[data-order-form]", { timeout: 30000 });
	await mockConnect(page);
	await page.getByRole("button", { name: "Account and wallet" }).click();
	await page.waitForTimeout(300);
	await page.getByText("Link mobile device", { exact: true }).click();
	await page.waitForTimeout(500);
	const createBtn = page.getByRole("button", { name: "Create phone link" });
	if ((await createBtn.count()) === 0) {
		console.log("DIAG body:", (await page.evaluate(() => document.body.innerText)).slice(0, 400));
		console.log("DIAG modals:", await page.getByRole("dialog").count());
		console.log("DIAG dialog text:", (await page.getByRole("dialog").innerText()).slice(0, 500));
		const btns = await page.getByRole("dialog").locator("button").allInnerTexts();
		console.log("DIAG dialog buttons:", JSON.stringify(btns));
	}
	await createBtn.click({ timeout: 8000 });
	try {
		await page.waitForFunction(() => document.body.innerText.includes("Phone link ready"), null, { timeout: 15000 });
	} catch (e) {
		const alertText = await page.getByRole("alert").allInnerTexts().catch(() => []);
		console.log("DIAG alerts:", JSON.stringify(alertText));
		console.log("DIAG after create:", (await page.getByRole("dialog").innerText()).slice(0, 600));
		throw e;
	}
	const modalText = await page.evaluate(() => document.body.innerText);
	check("ready panel shows the full link text", modalText.includes("mobile-agent-sync#ht-mobile-sync="));
	check("localhost warning is shown when running locally", modalText.includes("localhost"));
	const rawCode = (modalText.match(/[0-9A-F]{4}[-\s]?[0-9A-F]{4}[-\s]?[0-9A-F]{4}[-\s]?[0-9A-F]{4}/) ?? [])[0] ?? null;
	pairingCode = rawCode ? rawCode.replace(/[^0-9A-F]/g, "") : null;
	check("desktop created the phone link + pairing code", Boolean(pairingCode), pairingCode);
	await page.getByRole("button", { name: /Copy phone link/ }).click();
	await page.waitForTimeout(300);
	phoneUrl = await page.evaluate(() => navigator.clipboard.readText());
	check("phone link copied", Boolean(phoneUrl && phoneUrl.includes("mobile-agent-sync")), (phoneUrl ?? "").slice(0, 90));
	await ctxA.close();

	// ---- phone ----
	const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
	const phone = await ctxB.newPage();
	await phone.goto(phoneUrl);
	await phone.waitForSelector('input[placeholder="0000-0000-0000-0000"]', { timeout: 20000 });
	check("phone link lands on the phone-access page", true);
	// Deliberately NO wallet on the phone: preview links must import with just
	// the pairing code (the catch-22 the user hit on mobile).
	await phone.waitForTimeout(300);
	const importBtn = phone.getByRole("button", { name: "Import phone access" });
	if ((await importBtn.count()) > 0 && (await importBtn.isDisabled())) {
		console.log("DIAG phone text:", (await phone.evaluate(() => document.body.innerText)).slice(0, 400).split("|").join("/"));
		console.log("DIAG connect texts:", await phone.getByText("Connect Wallet").count());
	}
	await phone.locator('input[placeholder="0000-0000-0000-0000"]').fill(pairingCode);
	await phone.getByRole("button", { name: "Import phone access" }).click();
	try {
		await phone.waitForFunction(() => document.body.innerText.includes("Phone access ready"), null, { timeout: 20000 });
	} catch (e) {
		console.log("DIAG import failed:", (await phone.evaluate(() => document.body.innerText)).slice(0, 500).split("|").join("/"));
		const alerts = await phone.getByRole("alert").allInnerTexts().catch(() => []);
		console.log("DIAG phone alerts:", JSON.stringify(alerts));
		throw e;
	}
	check("pairing code imports the agent — Phone access ready", true);
	const previewCopy = await phone.evaluate(() => document.body.innerText);
	check(
		"phone page says no wallet is needed in preview",
		previewCopy.includes("No wallet needed in preview"),
	);
	const phoneText = await phone.evaluate(() => document.body.innerText);
	const agentMatch = phoneText.match(/0x[0-9a-fA-F]{40}/);
	check("phone shows the agent trading key address", Boolean(agentMatch), agentMatch?.[0]?.slice(0, 12));

	// ---- the linked key must actually drive the terminal (no wallet) ----
	// Regression guard: the account view used to early-return the disconnected
	// branch on wagmi's isConnected, so a linked key showed a card and no data.
	await phone.getByRole("button", { name: "Open terminal" }).click();
	await phone.waitForSelector('[aria-label="Primary navigation"]', { timeout: 30000 });
	const sessionOwner = await phone.evaluate(() => {
		const raw = localStorage.getItem("hyperliquid_agent_session_Mainnet");
		return raw ? JSON.parse(raw).address : null;
	});
	check("session pointer survives into the terminal", Boolean(sessionOwner), sessionOwner ?? "missing");

	await phone.locator('[aria-label="Primary navigation"]').getByText("Account", { exact: true }).tap();
	await phone.waitForTimeout(1200);
	const accountText = await phone.evaluate(() => document.body.innerText);
	check(
		"account view is NOT stuck on the connect-wallet screen",
		!accountText.includes("Connect your wallet to view your account"),
		accountText.slice(0, 80).split("\n").join(" / "),
	);
	check("account view shows the account data (equity)", /Equity/i.test(accountText));
	check("account view labels the session as a trading key", accountText.includes("Trading key"));
	check("account view offers to forget the key", accountText.includes("Forget this key"));
	check("account view hides the wallet disconnect action", (await phone.getByLabel("Disconnect wallet").count()) === 0);

	// Positions tab must reach the same account rather than the empty state.
	await phone.locator('[aria-label="Primary navigation"]').getByText("Positions", { exact: true }).tap();
	await phone.waitForTimeout(1200);
	const positionsText = await phone.evaluate(() => document.body.innerText);
	check(
		"positions view is NOT stuck on the connect-wallet empty state",
		!positionsText.includes("to view positions"),
		positionsText.slice(0, 80).split("\n").join(" / "),
	);

	// The order form must be usable: available balance resolved (not the "—"
	// placeholder) and the submit button not stuck on "Connect Wallet".
	await phone.locator('[aria-label="Primary navigation"]').getByText("Trade", { exact: true }).tap();
	await phone.waitForTimeout(1500);
	const tradeText = await phone.evaluate(() => document.body.innerText);
	const connectButtons = await phone.getByText("Connect Wallet", { exact: true }).count();
	check("trade form is not showing a Connect Wallet button", connectButtons === 0, String(connectButtons));
	check(
		"trade form resolves an available balance for the linked key",
		/Available/i.test(tradeText) && !/Available\s*—/.test(tradeText),
		tradeText.split("\n").filter((l) => /Available|Long|Short|Buy|Sell/.test(l)).slice(0, 4).join(" | "),
	);

	// "Forget this key" must clear both the key and the pointer.
	await phone.locator('[aria-label="Primary navigation"]').getByText("Account", { exact: true }).tap();
	await phone.waitForTimeout(600);
	await phone.getByRole("button", { name: "Forget this key" }).tap();
	await phone.waitForTimeout(800);
	const clearedPointer = await phone.evaluate(() => localStorage.getItem("hyperliquid_agent_session_Mainnet"));
	check("forgetting the key clears the session pointer", clearedPointer === null, String(clearedPointer));
	const afterForget = await phone.evaluate(() => document.body.innerText);
	check("forgetting the key returns the connect screen", afterForget.includes("Use a key from my desktop"));
	await ctxB.close();
} catch (e) {
	check("mobile link flow", false, String(e).slice(0, 240));
} finally {
	await browser.close();
}

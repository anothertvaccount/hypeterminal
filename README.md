# HypeTerminal

An ultra-fast, open-source trading terminal for [Hyperliquid](https://hyperliquid.xyz) — perps, spot, and builder-deployed perp DEXes — with real-time market data, full order-type support, and multi-wallet / agent-wallet signing.

**Live:** [app.hypeterminal.com](https://app.hypeterminal.com) &nbsp;·&nbsp; **About:** [hypeterminal.com](https://hypeterminal.com)

## Highlights

- **Every Hyperliquid market** — perps, spot, and builder-deployed perp DEXes in one interface.
- **Real-time everything** — L2 order book, trades, and market data over resilient WebSocket subscriptions.
- **Full order support** — market, limit, and advanced order types with margin and leverage controls.
- **Multi-wallet signing** — connect multiple wallets; agent wallets for low-friction trading.
- **Fast by construction** — server-rendered and streamed (TanStack Start), React 19, aggressive code-splitting.
- **Open & inspectable** — the entire trading surface lives in one public monorepo.

## Why this exists

Hyperliquid is an open blockchain, and serious users should have open-source clients and tooling they can inspect instead of relying only on closed trading interfaces. HypeTerminal keeps the trading surface reproducible: market data, order flow, signing, wallet flows, and UI primitives live in one public monorepo.

This repo is a pnpm monorepo. The `apps/terminal` web app is the product; the `packages/*` are the pieces it's built from. Each package/app has its own README with depth — this file is the map.

## Monorepo map

```
hypeterminal/
├── apps/
│   ├── terminal/                         # the trading app (TanStack Start + Vite + SSR) → app.hypeterminal.com
│   │   └── README.md  ───────────────▶   apps/terminal/README.md
│   └── website/                          # marketing site (Astro, static)               → hypeterminal.com
│       └── README.md  ───────────────▶   apps/website/README.md
├── packages/
│   ├── hl-react/                         # @hypeterminal/hl-react — React bindings for Hyperliquid
│   │   └── README.md  ───────────────▶   packages/hl-react/README.md
│   ├── ui/                               # @hypeterminal/ui — design system (Base UI + Tailwind v4 + CVA)
│   │   └── README.md  ───────────────▶   packages/ui/README.md
│   └── hyperliquid-api/                  # Agent Skill for AI tools (NOT a runtime dep)
│       └── SKILL.md   ───────────────▶   packages/hyperliquid-api/SKILL.md
└── .claude/rules/                        # coding conventions — see "Conventions" below
```

**Source-shipped packages.** `hl-react` and `ui` have `"main": "./src/index.ts"` — no build step. The Vite dev server type-checks, transpiles, and HMRs directly from source.

## How the pieces fit

```
┌──────────────────────────────────────────────────────────────────┐
│ apps/terminal                                                    │
│   React 19 + TanStack Start (SSR) + Vite 7 + Tailwind v4         │
│   Routes · Stores (Zustand) · Order entry · Chart · Orderbook    │
└──────────┬──────────────────────────────────────────┬────────────┘
           │ imports hooks                            │ imports primitives
           ▼                                          ▼
┌─────────────────────────────────────┐   ┌──────────────────────────────┐
│ @hypeterminal/hl-react              │   │ @hypeterminal/ui             │
│ ─ HttpTransport + WebSocketTransport│   │ ─ Base UI primitives         │
│ ─ useInfo / useSub / useExchange    │   │ ─ CVA variants               │
│ ─ Agent-wallet lifecycle            │   │ ─ Tailwind v4 `@theme` tokens│
│ ─ WS reliability + payload guards   │   │ ─ Phosphor icons             │
└─────────────┬───────────────────────┘   └──────────────────────────────┘
              │ wraps
              ▼
       @nktkas/hyperliquid  ──▶  Hyperliquid API (REST + WS)
```

- `hl-react` owns **everything about talking to Hyperliquid**: transports, hook types (info/sub/exchange), signing, agent wallets, WS reliability.
- `ui` owns **everything about how the app looks**: primitives, tokens, variants. Design-system only — no app logic.
- `terminal` composes the two into the product: routes, state, business rules, pages.

## Quick start

Prereqs: **Node 22.19+**, **pnpm 9+**.

```bash
git clone https://github.com/vipineth/hypeterminal.git
cd hypeterminal
pnpm install
pnpm dev                    # trading app at http://localhost:3000
```

The marketing site runs separately: `pnpm --filter @hypeterminal/website dev` → http://localhost:3010.

### Preview (paper) trading

Set `VITE_PAPER_TRADE=true` in `apps/terminal/.env.local` (see `.env.example`) and restart the dev server to
gain a simulated **$100,000** account:

- Balances, max sizes, and leverage work without depositing anything — connect any wallet (the dev-only
  **Mock Wallet** needs no browser extension) or an already-connected account.
- **Fund movement lives on Hyperliquid**: deposit, withdraw, and bridging are not offered in-app —
  move funds on the exchange, then come trade here.
- Market orders, closes, and reverses fill **locally**: nothing is signed and no order is sent to Hyperliquid.
  Limit orders rest on a simulated book — they show up in the Orders tab and as **draggable lines on the
  chart**: drag a line to reprice the order, and it fills automatically when the market trades through the
  price. Simulated positions appear in the Positions table with live PnL from market marks. Fills run on
  **live Hyperliquid price data**: market orders and marketable limits (already through the mark) fill within
  about a second of placement **at the current market price — never worse than your limit**, while a limit
  parked away from the mark waits for the real market to reach it
  — exactly like live. Trigger-only
  plans (TP/SL, stop entries) rest on the book too and **execute from the fill engine** when the mark trades
  through their trigger price — take-profits fire as price rises into them for longs (and falls for shorts),
  stops the other way around.
- Money movement (withdraw / send / transfer) is blocked while previewing, and the trade panel's clickable
  **preview badge is the mode switch**: click it to **reset the preview account** or swap between preview and
  live. The choice is stored per browser (the env flag stays the default) and the app reloads into the chosen
  mode — going live needs an explicit confirmation step.
- Preview state **survives refreshes**: positions, resting orders (limits and TP/SL triggers) and **realized
  PnL** persist locally. Realized PnL is credited to or debited from the simulated balance — close a winner
  and your account value grows; the size slider's available balance follows. The **Account panel** mirrors
  exchange semantics with live marks: Balance is cash (equity − uPnL), and Unrealized PnL, position notional,
  cross leverage and margin ratio all update as the market moves.

### Builder fee (live orders)

None by default. Self-hosted installs attach **no builder code**, pay no builder fee, and show no "Builder
Fee" row in the order summaries. To charge one (yours, or the upstream authors'), set
`VITE_BUILDER_ADDRESS=0x…` (and optionally `VITE_BUILDER_FEE`, units where 10 = 0.01%, max 100) in
`apps/terminal/.env.local`. Preview orders are simulated locally and never carry a builder code.

To revoke builder-fee approvals your wallet has **already** granted other frontends (check with
`{"type":"approvedBuilders","user":"0x…"}` on the public info API), open **`/dev-builder-fees`** in a dev
build: it lists every approved builder with its cap and sets each to **0%** via one wallet signature per row
(no trades, no transfers — the signed action only updates your fee allowance).
- With **Reduce Only** checked, the size slider and % buttons scale against your **current position** (or,
  when flat, against your resting buy limits for that market) instead of the balance-based maximum — the
  same behavior applies in live trading.

Set the flag back to `false` (or remove it) to return to live trading.

### Fill alerts

Every fill — preview (paper engine) or live (`userFills` stream) — plays a short two-note chime (buys
ascend, sells descend) and shows a brief card in the **top-right**: side, market, kind (`Limit`/`Market`/
`TP`/`SL`), size **@ the execution price**, “Filled”, and a `preview` tag while paper trading. Cards
auto-dismiss after ~3.5s (or click ✕); the speaker button mutes **all trade sounds** (persisted per browser).
A different, dry **tick** plays when an order is **placed or cancelled** — the melodic chime is reserved for
fills. Historical fills from the live stream never chime — only fills that actually happen while the app is open.

### Quick size buttons

A `$5 / $50 / $100 / $250 / $500` row sits above the size slider: each click **adds its USD amount** to the
order size (quote mode is exact; base mode converts through the mark and floors to the market's size
precision), and **`CC`** clears the size back to zero. The size field also **remembers your last size after an
order is placed** (it still starts empty on a fresh page). The amounts are editable — **Settings → Size buttons**
(configurable per browser, with Reset back to defaults). The row appears for perps and builder perps; spot
sizes aren't USD-denominated, so it's hidden there.

### Chase limit

The order-form dropdown includes **Chase Limit** (perps) with a **TIF selector** — **post-only (Alo, the
default)** or **Gtc**. The placement price comes from a **fresh book snapshot** at submit (best bid for buys,
best ask for sells): non-marketable *by construction*, which is what makes post-only safe and keeps the order
**maker-side**; if the book moves through the price in the ~50ms before the exchange sees it, the benign
rejection is re-fetched and retried automatically. Gtc joins the same touch and may fill at ≤ it. A client-side
engine then re-prices it **every 750 ms** to the top of the real book so it
keeps riding the touch when the book moves away (no-op while it's already there; the first correction fires
immediately, and the30-second auto-cancel counts from placement, not from the last re-price). The Reduce
Only toggle works normally, so you can chase an exit too. Hyperliquid has no native chase order (its wire
format only knows Gtc/Ioc/Alo/FrontendMarket limits and triggers) — this is the client-side loop, the same
approach every chase UI takes. The **Chase tab** (directly right of Order History, desktop + mobile) shows
the running chase — side, size, book side, and an elapsed/30s progress bar — plus the **persisted history**
of finished chases (Filled / Timed out / Cancelled / Failed with price and duration), which survives
refreshes. Only one chase runs at a time: starting a new one (or navigating away) cancels the previous
order so nothing is ever left unmanaged — the30s promise holds per **entry** chase. A **reduce-only** chase
(including the Positions tab's **Chase Close** action — post-only, sized to the full position, market
switched for you) never times out: it rides the touch until the position is flat, and when the remainder
drops below Hyperliquid's $10 minimum it stops with an explicit *"$X of COIN remains — below minimum"*
message instead of stranding dust no order can ever close.

*Preview caveat*: re-pricing tracks the **real** book, but preview fills still trigger when the live mark
trades through the resting price — there is no maker-queue simulation, so chasing in preview is an
approximation (as you noted: nobody is actually filling your bids there).

### Hotkeys

Every shortcut ships with sensible, battle-tested **default keys**: hold `A`/`D`/`S`/`B`/`V`/`Z`
and click a price on the chart (buy / sell / side-auto limit / TP / SL / set price), `Alt+Shift+A`/`D` submit the
form as a limit, `X`/`U`/`I`/`O`/`P` cancel by scope (newest / buys / sells / active market / everything),
`Ctrl+Alt+A/D` and `Ctrl+Shift+A/D` quote the book (top of book; 25% toward mid as the "track-price"
approximation), `Q`/`W`/`H` toggle post-only / reduce-only / the order form, and `?` opens the shortcut help.
Keys are ignored while you type in any field (and during IME composition), key-repeat never double-fires, and
`Shift+B`/`Shift+S` stay reserved for the chart.

- **Nuke button** (bomb icon, top bar): asks **"Are you sure?"** with No / Yes — Yes cancels every
  resting order across all markets and market-closes every position (preview and live alike); partial
  failures are listed in the dialog.
- **Open Orders badge** counts preview orders too (it read only the live exchange stream before).
- **Top-bar keyboard button** toggles all hotkeys on/off (persisted; the icon shows the live state).
- Rapid hold-key + click spam is safe: a press that doesn't move is always a chart click (only real drags
  and ✕/TP/SL presses consume a gesture), and each click places its own order — chart submissions are never
  dropped while a live submit is in flight.
- **Settings → Hotkeys** is its own page: click a key chip and press the new key (Esc/Backspace cancels), ✕
  unbinds a key, conflicts **swap** bindings so nothing ever overlaps, and **Reset** restores the original
  defaults. Rebinds persist per browser and show a `custom` marker everywhere keys are listed. Actions this
  build can't do (track-price, chart scale preview, chase) are listed read-only — while the actions with
  **no default key** (market buy/sell, market/limit close, flatten, size presets) are fully bindable here;
  size presets apply your quick-size amounts from **Settings → Size buttons**.
- **TP/SL seeds ±2% with canvas previews**: toggling TP/SL fills the fields with **±2% off the reference
  price** (side-aware, editable; cleared on toggle-off so every enable re-seeds) and draws three dashed
  **PREVIEW** lines on the chart — the limit, the proposed TP and SL — each labeled *"not in book until
  submitted"* in muted gray. Each TP/SL preview also shows the **realized PnL for the size currently in the form** (and
the limit line its notional), so you see the dollar impact before submitting. The previews are
**draggable like real order lines**: a release writes the new
  price into the matching form field (never to the book). They follow the form field by field and never touch
  the book: only a submit creates real orders.
- **Scale ladder preview**: the scale form's **Preview** button (enabled once start, end and order count are
  valid) draws every ladder level as a PREVIEW line with the same labels; **SCALE START** and **SCALE END**
  drag into their fields, middle rungs spring back (a scale is a range, not per-level prices), and **Hide
  preview** — or submitting — clears the ladder. The scale form also has the **TP/SL checkbox**: its
  ±2% defaults reference the ladder's midpoint, the TP/SL previews draw right alongside the rungs, and a
  submit places the ladder plus the shared reduce-only triggers as one `normalTpsl` batch. **Filling scale prices previews itself**: a lone start (or end) shows its own
  line, both ends draw the full ladder (the Preview button stays as a manual toggle), and **clean chart
  clicks set Start/End directly** — clicks alternate start ↔ end (the form hints which is next; pans, axis,
  menu and label presses never count). Each rung's label shows **the size of that one order** (ladder size ÷
  levels). Two interactive **distribution curves** — *Price Distribution* and *Amount Distribution* — reshape
  the ladder your way: pick **Flat / Start / End** or drag the curve's nodes yourself. Price curves
  keep both endpoints pinned (the ladder always spans exactly start…end) and spacing follows the curve;
  amount curves split the total size by weight. The canvas preview and the submitted orders read the very
  same math, so what you shape is exactly what ships.
- **TradingView is the default chart on load**; the original klinecharts canvas stays one click away in
  the toolbar and takes over automatically if the widget fails to load or never becomes ready.
- **TradingView canvas parity**: everything above also runs on the TradingView chart — preview lines with
  drags into the form, order labels + ✕ cancel + drag-to-reprice, the position line with TP/SL press-drags
  and ghost chip, the price-axis cross/menu, and hold-key + click chart actions (same rebinds). The widget
  lives in an iframe with no public price→pixel API, so a DOM overlay layer is driven by a linear fit from
  `getVisiblePriceRange()` + the plot's measured rect; pointer events are forwarded from the same-origin
  iframe document (so TradingView's native price-axis drag-to-scale keeps working), and hold-key clicks arm a
  capture layer only while a chart key is held. **Indicator layouts persist**: the widget auto-saves its
  serialized chart (indicators + drawings) through a localStorage save/load adapter and rehydrates it on the
  next reload — applied to the currently selected market. A corrupted saved state (price axis
  captured on the wrong side) self-heals instead of bricking the canvas: the axis returns to the right
  and chart trading keeps working.
- **Default limit size** (Settings → **Default size**, $100 USDC out of the box): switching to the Limit tab
  with an empty size prefills it — quote mode stores the USD amount exactly, base mode converts at the
  entry/mark price. A size you typed is never overwritten (sticky-size behavior wins) — the **last size you
  used is remembered across refreshes on every order form**, and the default only fills a size that was
  never used.
- **Order queue popup** (bottom right) hides itself after **30 seconds** without a new order; its ✕ closes
  it immediately, and any new order brings it back.
- **Reduce Only is sticky per side**: long and short each remember their own state — toggling it on one
  side never changes the other — and it survives order submission and page reloads until you change it.

### Chart trading

Every line on the kline chart carries a row of bordered label boxes and a price badge on the right axis:

- Hovering the **price axis** shows a cross just inside the pane — never on the label strip, so the axis'
  drag-to-scale/zoom stays untouched — and its menu prefills Limit Buy/Sell **or places Take Profit / Stop
  Loss for 25/50/75/100% of your open position at that exact price**.

- **Order lines** show the order type (`Limit` / `TP` / `SL`), then the risk numbers: `[if-hit / cumulative]`.
  The first number is what that order alone realizes if it fills (reduce-only closes against your average
  entry, opening orders show `+0.00 USD`). The second is the cumulative scenario — the mark trades to the
  order's price, every open order between the current mark and that price fills on the way (nearest first),
  and the number is what the account is worth there (realized closes + PnL of the position that remains).
  It works **flat**: your resting ladder alone produces it. Flags `[R]` (reduce-only) and the time-in-force —
  `[GTC]`, `[IOC]`, or `[P]` for post-only (the order form's default TIF) — follow, then the order size in USD,
  then a **✕** button that cancels the order (locally in preview, via the exchange in live mode). Lines stay
  draggable to reprice — TP/SL lines drag their trigger price.
- **The position line** sits at your average entry with a `Long`/`Short` badge, position size in USD, live
  uPnL, and **TP/SL buttons**: press a button and drag to a price level, release, and a reduce-only market
  trigger for **100% of the position** is placed at that price (paper: rests on the simulated book; live:
  sent as a normal-TP/SL group). The **entry line never moves** — while you drag, a floating chip shows the
  projected PnL and return from entry (`+$20.17 │ TP │ +6.01%`) at the drop price with a dashed connector
  back to the chip; a plain click places nothing.
- Labels read live marks every draw, so the risk numbers and uPnL update without rebuilding the lines.

### Root scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server for the trading app (`apps/terminal`), HMR across the workspace |
| `pnpm build` | Build the trading app (Lingui compile + Vite production build) |
| `pnpm build:website` | Build the marketing site (`apps/website`, Astro) |
| `pnpm build:all` | Build both apps |
| `pnpm serve` | Preview the built trading app |
| `pnpm test` | Vitest across the workspace |
| `pnpm typecheck` | `tsc` across every package |
| `pnpm verify` | `check` + `typecheck` + `test` + `build:all` — the full pre-push gate |
| `pnpm lint` / `format` / `check` / `fix` | Biome |
| `pnpm i18n:extract` / `i18n:compile` | Lingui catalog management |

Per-package commands live in each subpackage — see their READMEs.

## Conventions

All project rules live in `.claude/rules/` and apply across packages:

| File | Scope |
|---|---|
| `code-style.md` | Component structure, comment policy, hook usage (React 19 compiler → no manual `useMemo`) |
| `hyperliquid.md` | Keep Hyperliquid API strings as strings; use `big.js` only when math is needed |
| `ui-library.md` | `packages/ui` is design-system only; app components live in `apps/terminal/src/components/` |
| `design-tokens.md` | Semantic tokens only (no hex); background elevation model (sunken→base→raised→overlay) |
| `style-ui-guide.md` | Border / focus conventions |
| `ssr.md` | SSR-safe module boundaries (no `window`/`document` at import time) |
| `git.md` | Commits: `type(scope): subject`, ≤72 chars, lowercase, imperative |

Commit types (Conventional Commits): `feat`, `fix`, `refactor`, `perf`, `style`, `test`, `build`, `ci`, `docs`, `chore`, `revert`.

## Further reading

- **[apps/terminal/README.md](apps/terminal/README.md)** — app architecture, routes, directory layout, order flow
- **[apps/website/README.md](apps/website/README.md)** — the Astro marketing site
- **[packages/hl-react/README.md](packages/hl-react/README.md)** — hook taxonomy, transport layer, agent-wallet lifecycle, WS reliability internals
- **[packages/ui/README.md](packages/ui/README.md)** — design tokens, component inventory, CVA patterns
- **[packages/hyperliquid-api/SKILL.md](packages/hyperliquid-api/SKILL.md)** — Agent Skill for AI tools working with the Hyperliquid API

## License

[MIT](LICENSE)

## Acknowledgments

- [Hyperliquid](https://hyperliquid.xyz) — the protocol
- [@nktkas/hyperliquid](https://github.com/nktkas/hyperliquid) — the TS SDK we build on
- [TanStack](https://tanstack.com), [Base UI](https://base-ui.com), [Tailwind](https://tailwindcss.com)

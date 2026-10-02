# PineTerm — your self-hosted charting and strategy workspace

An original, single-user crypto-first terminal built around [Vela](https://github.com/LuxAlgo/Vela), [PineTS](https://github.com/LuxAlgo/PineTS), and [Pi](https://github.com/earendil-works/pi). No TradingView affiliation, copied branding, or full-parity claim.

![Running PineTerm chart workspace](design/screenshots/pineterm-desktop.png)

*Actual production application screenshot—not an image-generation concept or fabricated trading result.* [Mobile chart](design/screenshots/pineterm-mobile.png) · [mobile watchlist](design/screenshots/pineterm-mobile-watchlist.png).

## Readiness

Verified: administrator sessions/scoped keys; transactional SQLite persistence; Binance/Coinbase OHLCV, quotes and streaming; historical CSV import/export; Vela layouts/drawings/settings; named workspaces/watchlists; immutable Pine library, browser indicators and isolated reproducible strategy backtests; server-authoritative spot paper trading and isolated bar replay; durable price/Pine alerts, signed webhook outbox and restricted Telegram bot support; scoped finance client and opt-in autonomous external executor handoff; OpenAPI and production serving. Pi UI is the remaining milestone and **not available yet**. Telegram and external execution protocol/security behavior are verified, but no real bot or sandbox-driver credentials have been supplied. No prices, portfolio gains, or model answers are seeded.

### Market data

Venues stay distinct: `BINANCE:BTCUSDT` is USDT, `COINBASE:BTC-USD` is USD, and `CSV:<datasetId>` is imported historical data. No fallback from Binance `.com` to `.us` or between exchanges. Common intervals `1`, `5`, `15`, `60`, `D`; larger intervals include `3`, `30`, `45`, `120`, `240`, Monday-UTC weeks (`W`) and calendar months (`M`). Missing candles are gaps, never fabricated zero-volume rows.

Authenticated routes: `/api/v1/providers`, `/markets?provider=&q=`, `/bars?provider=&symbol=&timeframe=&from=&to=&limit=`, `/quotes?provider=&symbol=`, `/bars.csv`, and WebSocket `/stream`. Bar opens are epoch milliseconds; ranges are half-open `[from,to)`. Pages contain newest `limit` bars ascending (default 500, maximum 5000); continue with exclusive `to=nextBefore`. Responses expose live/stale/historical state, observation time and gaps. A provider failure is an error or explicit stale cache with `providerError`, not successful empty live history.

`POST /api/v1/datasets` accepts admin-session multipart: `name`, `baseCurrency`, `quoteCurrency`, `timeframe`, `tickSize`, `quantityStep`, and a CSV `file` (maximum 10 MiB). Exact header `time,open,high,low,close,volume`; UTC ISO-8601 `Z` or epoch milliseconds, not ambiguous seconds. Validation rejects duplicate timestamps, misalignment, invalid OHLC, nonfinite values or negative volume atomically. Imported feeds stay historical and cannot drive live execution. See OpenAPI for request/response schemas.

`npm run smoke:core -- --scenario data` exercises reversed fixture import, exact bars/ranges/pages/export, atomic failures, reference-counted authoritative close streaming and explicit stale failures. `PINETERM_SMOKE_URL=http://127.0.0.1:3100 npm run smoke:providers` exercised real authenticated Binance and Coinbase candles, successive forming-bar updates and fresh quotes. Supply `PINETERM_SMOKE_TOKEN` or a local admin password securely in the environment; any temporary read key created by the smoke is revoked afterward.

### Chart workspace

The original graphite/teal/rose React shell retains Vela’s chart chrome, drawing toolbar, object tree, undo/redo, scale/timezone settings and attribution. Choose `1`, `2h`, `2v`, `4` or `8` cells; linked crosshair, symbol, timeframe and viewport controls use Vela’s public workspace API. Styles include candles, OHLC bars, line, area, baseline and Heikin-Ashi. Synthetic display styles never replace raw backend candles for exports or future execution.

**Manage workspace** creates, renames, copies and deletes named server-backed documents. Saves are serialized, debounced and revision-guarded; **Flush** captures current chart state. Network failures retain a local draft. A conflicting revision offers explicit Reload or Save as copy, never silent overwrite. Unsupported/corrupt saved state remains available through **Download original state**. Watchlists keep ordered provider-qualified instruments; select a row to change the active chart, and use the displayed observation timestamp/freshness rather than assuming an executable price.

At tablet widths, right/bottom docks become exclusive keyboard-accessible drawers. At phone widths, one active chart fills the view while the saved multi-cell grid remains intact and returns on desktop. CSV export uses the backend’s half-open range rules. Vela PNG export includes chart/drawing raster but DOM overlays are best-effort and outer application docks are not included; product screenshots above capture the full browser.

Browser verification exercised real venue switching, trend-line drawing/persistence, `1 → 4 → 1` and eight-cell layouts, Heikin-Ashi, watchlist reordering, CSV/PNG downloads, historical CSV upload, mobile drawers/Escape, saved reload, and a real revision conflict with explicit recovery. Development and built production surfaces were both exercised. `npm run smoke:core -- --scenario workspace` exercises actual HTTP persistence/CAS/ordering; behavior tests also prove restart preservation.

**Image-reference prerequisite:** both session enablement and the subsequently requested global save of `generate_image.enabled` timed out unanswered in the configuration approval flow; the effective setting remained `false` from its default. No generated desktop/mobile reference images exist, and no SVG mockups were substituted. The implemented UI follows the approved textual layout/palette; screenshots are actual running-product images.

### Pine scripts and Strategy Tester

CodeMirror provides Pine text editing, line numbers and search—not a complete Pine language server. The original editable library includes SMA, EMA, RSI, MACD, Bollinger Bands, volume and an EMA-crossover strategy. Save creates immutable source/parameter revisions; rename/archive never erase prior job provenance. Import/export `.pine`; input controls use variable/declaration IDs, not ambiguous display titles. Explicit overrides take precedence over source settings, then runtime defaults.

**Add to chart** runs a browser preview in Vela’s per-cell PineWorkerEngine. Overlay/separate-pane, visibility/removal and workspace reload are supported through public Vela APIs. Browser workers provide responsiveness isolation, **not a security sandbox**: the pinned Blob worker needs CSP `unsafe-eval`. Script hosts remain restricted to `self`; do not run untrusted scripts merely because they use a worker. Browser previews may reflect synthetic chart styles and are never durable alert/order authority.

The server only executes Pine in nonroot Docker containers: network disabled, read-only root, no capabilities/host mounts/socket/secrets, 512 MiB, one CPU, 64 PIDs. Compilation is limited to 10 seconds; whole execution to 60 seconds; two concurrent slots, bounded queue, 50,000 total primary/secondary bars and 20 secondary series. Missing Docker/image returns `503 RUNNER_UNAVAILABLE`; there is no API-process execution fallback. Cancellation/deadline cleanup confirms termination before settling.

Backtests require an immutable saved strategy revision and an explicit UTC, aligned, half-open date range with complete confirmed raw candles. Gaps, missing confirmation, currency mismatch and excessive history reject instead of producing a shortened profit report. Results retain equity/drawdown, fills/fees, resolved settings, source/parameter/bar/metadata hashes and engine version. Export trades CSV; view fill markers and immutable provenance. Undefined metrics, including profit factor without losses, are `null`.

**Provider-locked MTF:** selected explicitly after proving PineTS 0.10.0 strips computed exchange prefixes before its public provider seam. All secondary data remains within the run/chart’s selected venue; computed prefixes cannot select another venue. Validation/results disclose this limitation. This is not TradingView namespace parity. Higher-timeframe data is clipped to the allowed close cursor; the fixture returned no 00:05 value at cursor 00:04, then 14 at 00:05.

PineTS also treats `currency.NONE` literally rather than resolving the instrument quote. Strategy currency must match quote currency exactly; USD is not USDT and no FX conversion is supplied. New strategy templates explicitly use the active quote currency, capital 10000, fixed quantity 1, commission 0.1%, slippage 0 and next-bar order processing. Existing/imported code retains its own settings.

`npm run smoke:core -- --scenario pine` exercised real Docker/HTTP execution: six-bar round trip entry 10 / exit 14, fees 2, final equity 1002; one-tick slippage entry 10.01 / exit 13.99, final 1001.98; capital override 2000 → final 2001.98. Paginated/unpaginated orders/trades/equity matched. SMA override, duplicate input titles, malformed source, no-future MTF, immutable revision/archive provenance, cancellation, API responsiveness and the actual 60-second timeout were exercised. [Actual Strategy Tester screenshot](design/screenshots/pineterm-backtest.png) uses the explicitly imported deterministic historical fixture—not portfolio gains.

### Paper trading and replay

Paper accounts hold one explicit quote currency with canonical decimal balances. No leverage, shorts, implicit USD/USDT conversion or real money. Set initial cash, commission (default 10 bps) and adverse slippage (default 0 bps) before creating an account. The ticket, reservations, cancellation, holdings/P/L, fills and cash ledger are server-owned and survive restart.

Live paper market orders wait for the first fresh observed quote **after** acceptance. Limits fill at-or-better; stops become market on crossing. Fees are charged separately, limit slippage is clamped at the limit, and unaffordable gaps reject rather than creating negative cash. Stale/disconnected feeds and CSV datasets cannot fill live paper. Reset requires explicit confirmation, archives the old audit ledger and creates a fresh account.

Authenticated API: `POST/GET /api/v1/paper/accounts`, `GET /paper/accounts/:id`, `POST /paper/orders` with `Idempotency-Key`, `POST /paper/orders/:id/cancel`, `GET /paper/orders`, `/paper/positions`, `/paper/fills`, and admin `POST /paper/accounts/:id/reset` with `{ "confirm": true }`. Reads require `paper:read`; placement/cancellation require `paper:trade`. Repeating an identical key/body returns the original order; conflicting reuse returns 409. See OpenAPI for full decimal-string request/response contracts.

**Bar replay** loads a complete confirmed window and creates a separate replay paper account. Start/step/Play/Pause/rewind/Stop use acknowledged server cursors; Play has one timer, not an independent chart clock. Native market/interval/layout switching is locked. Frozen chart tapes use the registered provider seam—not Vela’s offline-data mode, which synthesizes ticks. Workers receive only completed primary/secondary bars at the acknowledged cursor, including older-client requests; entry/rewind clears secondary caches and browser engines. Backtest fill markers are hidden during replay. Stop refreshes current live history; rewind archives the later replay ledger and starts a fresh account.

Replay market orders fill at the next raw-bar open. Limit/stop fills use deterministic OHLC gap rules, not an invented intrabar path; coarse-only datasets acknowledge at bar close and exclude orders accepted mid-bar. No OCO guarantee. Replay never sends live orders or notifications; separately armed server live alerts continue. Historical CSV is replayable, not a live venue.

`npm run smoke:core -- --scenario paper` exercised actual HTTP buy 2 @ 10 → cash 980, sell 1 @ 12 → cash 992/holding 1/realized P/L 2, idempotency, stale waiting, cancellation and restart preservation. `--scenario replay` proved next-open fills, unchanged live ledger, fresh-account rewind, stopped-session rejection, and 5-minute value absent at 00:04 → 14 at 00:05. Behavior tests also exercise concurrent reservations, slippage/fees, unaffordable gaps and same-market live-quote isolation. Actual development/production browser checks exercised live paper buy/cancel, replay buy/step, rewind, Play/Pause, mixed 1m/5m no-future reveal, mobile ticket/Escape and return-to-live. The actual Pine worker’s `request.security(..., "5", close, lookahead=barmerge.lookahead_off)` returned `null` at cursor 00:04 and 14 at 00:05, matching the isolated runner. [Actual replay screenshot](design/screenshots/pineterm-replay.png) uses an explicitly imported historical fixture, not live portfolio gains.

### Durable alerts and notifications

**Alerts** creates server-owned price `above/below/crosses_above/crosses_below` and Pine `alert()` / exact named `alertcondition()` definitions. Choose an explicit live venue, interval, confirmed-close or price-only quote mode, `all/any` flat groups, and once/once-per-bar frequency. Pine/mixed groups share one immutable script revision plus varID input overrides; editing or archiving its library source never changes an armed definition. CSV/replay cannot arm live alerts.

First observation establishes a baseline without firing. Quote above/below fires on false→true only; crossings compare previous/current price. Once-per-bar emits at most one signal per definition revision/timeframe bucket, including scripts with multiple `alert.freq_all` occurrences. Pine evaluation uses the real isolated runner, fixed persisted warm-up (last 500 confirmed bars unless an earlier start is selected), and cursor-clipped primary/secondary history. Warm-up never delivers; reaching compute/history limits pauses with an actionable reason.

Definitions, watermarks, crossing state, signal IDs and delivery rows survive restart. Outage recovery rebuilds current state and records missed intervals without stale catch-up notifications. Event plus outbox persistence is atomic. Pause/resume/re-arm/delete and labelled destination tests are explicit UI actions; deletion retains audit. Separately armed live alerts keep evaluating during chart replay. No destination means history only.

**Settings → Notifications** manages encrypted webhook signing secrets and a dedicated Telegram bot token. GET/API/browser storage never returns or persists these secrets. Webhooks require HTTPS, fresh DNS validation of public IPv4/IPv6 answers, a pinned destination per request, no redirects, bounded bodies and a ten-second delivery deadline. Private/loopback/link-local/metadata/reserved answers are rejected. `PINETERM_DEV_WEBHOOK_HOSTS=127.0.0.1` permits only an explicit exact development host for a local recording receiver; production refuses this setting.

Verify `X-PineTerm-Signature: sha256=<hex>` with HMAC-SHA256 over `X-PineTerm-Timestamp + "." + exact raw request bytes`. Payload includes stable `eventId`, `alertId`, `occurredAt`, venue-qualified `market`, `timeframe`, `message`, and optional `scriptRevisionId`. Delivery is **at-least-once**: interrupted sends may duplicate. Deduplicate by event ID. Durable states are pending/sending/delivered/failed; transient retries follow 5/30/120 seconds, with 429 Retry-After honored. Delivery history shows attempts/status/error; an HTTP 2xx alone is not receiver-side signature attestation.

Telegram uses fixed `api.telegram.org`, plain text ≤4096 characters, `getMe/getWebhookInfo` tests and persisted-offset `getUpdates` polling. Incoming `/status`, `/alerts`, `/positions` require both allowed chat **and** sender user IDs; `/pause_alerts` pauses notification delivery only, not evaluation or execution. No trading commands or model-generated Telegram actions. An existing webhook is an explicit dedicated-bot conflict; PineTerm never deletes it automatically. Global notification pause/resume is independent of alert evaluation.

Admin-session routes: `GET/POST /api/v1/alerts`, `GET/PUT/DELETE /alerts/:id`, `POST /alerts/:id/test`, `GET /alert-events?alertId=`, webhook CRUD/tests under `/webhooks`, Telegram configuration/test under `/integrations/telegram`, and notification-only pause under `/integrations/notifications`. Mutations require Origin/CSRF; scoped API keys cannot configure channels. Full contracts are in OpenAPI.

`npm run smoke:core -- --scenario alerts` exercised actual HTTP/browser-independent 10→12→13 crossing, event persistence before delivery/restart, stable IDs and actual-byte HMAC 500→200 retry, real Docker Pine `alert()`/named/mixed conditions without warm-up delivery, immutable-source changes, three missed outage intervals without stale dispatch, fresh recovery and labelled tests. Behavior checks cover mapped IPv6, mixed/rebound DNS, redirect rejection, retry exhaustion/429, late-ack deletion races, encrypted secrets and unauthorized Telegram commands. Production/development browser checks exercised price/Pine/group forms, varID overrides, archived-root preservation, pause/re-arm/history, signed local delivery, write-only secret clearing and mobile forms/Escape. [Actual alert screenshot](design/screenshots/pineterm-alerts.png) shows a labelled local-protocol test, not a live trading signal or real HTTPS receiver acceptance.

### Finance API and opt-in external handoff

[FinanceClient](examples/api-client/src/index.ts) is a real TypeScript client for scoped market reads and paper buy/sell/cancel/account/fill routes. It has bounded JSON requests and **no automatic mutation retries**. Run `npm start -w @pineterm/api-client` with `PINETERM_API_URL`, `PINETERM_API_TOKEN`, `PINETERM_API_PAPER_ACCOUNT_ID`, `PINETERM_API_QUANTITY` and `PINETERM_API_LIMIT_PRICE` in the environment. Provider/symbol/timeframe use optional `PINETERM_API_PROVIDER/SYMBOL/TIMEFRAME` (Coinbase BTC-USD 1m by default). The command reads bars, places an explicitly sized **paper** limit order, cancels if still open and reads the server portfolio/fills; choose a non-marketable price for cancellation proof. Read-only keys cannot trade.

**Settings → Execution** registers external executors and a revision-guarded policy. Fresh installations start disabled with empty allowlists and blank numeric limits. Enabling requires an enabled executor, exact live market/side allowlists, positive per-order/rolling-24h budgets per quote currency, explicit maximum pending count and price deviation. USD and USDT never share a converted budget. The persistent **LIVE HANDOFF ENABLED** badge and **Kill handoff** control remain visible outside Settings.

PineTerm never stores exchange credentials or contacts an exchange to place an order. `POST /api/v1/order-intents` takes a fixed executor/market/side/type/quantity/optional limit and explicit `expiresAt` ≤60 seconds ahead, with `live:intent` plus `Idempotency-Key`. It reserves risk atomically using authoritative fresh quotes/instrument precision. Market reservations use the protected worst-case upper reference price; limits use the greater fresh reference/limit. The accepted market reference is immutable: claim may tighten its original band, never rebase/widen it. Historical/replay/backtest origin fields and client prices are rejected.

Executor-bound `executor:claim` keys lease one intent for 30 seconds through `POST /executors/:id/claim`; `clientOrderId` is always the intent UUID. `GET /executors/:id/control` exposes cancellation requests and the original recoverable lease only to that bound key. Ordinary intent/administrator views never contain lease tokens. A dropped claim, timeout or interrupted server becomes **unknown**, not redispatched; its capacity/notional stays reserved even beyond 24 hours. The executor must reconcile the stable ID. A positive absence assertion cannot release a recovered ambiguous order before its original submission deadline.

`POST /order-intents/:id/reports` requires the original lease token and a bound `executor:report` key, even for late reconciliation. Report/fill IDs deduplicate transactionally; conflicting IDs, overfills, adverse protected-price breaches and invalid transitions fail. Exact report replay returns its original response. Signed fee credits remain in their stated currencies. Partial outcomes retain conservative full/unexecuted risk until terminal proof; favorable fills can increase retained notional. Externally reported net fill deltas are displayed **separately from paper cash/holdings**, not as complete exchange balances or portfolio P/L.

Cancelling an unclaimed intent is immediate. Claimed/acknowledged/partial/unknown orders only receive `cancelRequested` until the driver reports cancellation. Kill rejects new handoffs/claims and requests external cancellation; it cannot guarantee that an already accepted venue order was cancelled. Administrator sessions cannot fabricate executor acknowledgements or fills.

Alerts may attach a separately selected fixed executor/market/side/type/quantity action. Fresh signal event plus action queue persistence is atomic; current policy applies at creation/claim. Disabled policy produces a visible failed action, not a stale later retry. Tests/missed intervals never execute. Pine alert text—even order-looking JSON—is display-only and cannot override fixed action fields. Notification-only pause does not pause these actions; pause the definition or use the execution kill switch. Pi remains analysis/scripting-only.

#### Operator executable contract

[ExecutorClient](examples/executor-client/src/index.ts) runs through `npm start -w @pineterm/executor-client -- --once` (omit `--once` for polling). Required environment: `PINETERM_EXECUTOR_URL`, `PINETERM_EXECUTOR_TOKEN` (both executor scopes, bound to one ID), `PINETERM_EXECUTOR_ID`, `PINETERM_EXECUTOR_DRIVER` (absolute executable), and `PINETERM_EXECUTOR_STATE` (absolute SQLite file in a user-owned private directory). No driver configured means **refuse before claiming**; no pretend broker is bundled.

Optional `PINETERM_EXECUTOR_DRIVER_ARGS` is a JSON string array, `PINETERM_EXECUTOR_TIMEOUT_MS` 1–30000 (default 10000), `PINETERM_EXECUTOR_POLL_MS` 100–30000 (default 1000). Invocation is `[driverArgs..., submit|status|cancel]` with no shell interpolation. One [DriverRequest](packages/contracts/src/execution.ts) JSON arrives on stdin; one strict, bounded DriverReply JSON leaves stdout. Driver stderr is suppressed; PineTerm/API/lease secrets are not forwarded to the driver. Exchange credentials remain in operator-owned non-`PINETERM_*` driver configuration.

`status` preflight must supply an actual same-venue fresh executable quote. The client enforces metadata/expiry/reference band before `submit`; the driver must use conservative tick-rounded buy caps/sell floors (price-protected/IOC-limit semantics) or refuse an unsupported venue, never fall back to unbounded market placement. Submission state is committed before process creation; reports retain the exact ID/body before networking. Timeout/shutdown waits for owned process-group termination. Crash/lost response recovery calls `status`/`cancel`, **never `submit` again**. `not_submitted` is not absence proof unless `absenceConfirmed:true` after the original deadline.

`--sandbox` additionally requires every driver reply to attest `environment:"sandbox"|"testnet"` plus a nonempty `venue`; read-only preflight checks this before submission. The expressly labelled [local recording driver](tests/fixtures/recording-executor-driver.mjs) is selected only by deterministic checks and identifies itself as `recording`—it is deliberately refused in sandbox verification mode.

`npm run smoke:core -- --scenario api-client` exercised actual Node CLI/scoped HTTP reads, a reservation of 2, same-order cancellation, cash1000/fills0 and read-only403. `--scenario executor` exercised actual Node/SQLite/subprocess handoff, disabled zero submissions, protected buy1/fill10 once, report dedup, quotas/precision/freshness/expiry/foreign bindings, original-token recovery after dropped claim/restart, no redispatch, ambiguous submit resolved by status, kill/actual cancel, notification-pause-independent fixed actions, and real isolated Pine JSON text that still created fixed buy1. Full suite: 113 behavior tests passed. Financial guards reject zero quantities/prices/steps with strict comparison, not decimal sign predicates. Test file workers are capped at two for real scrypt/Fastify/SQLite/Docker resources; normal test deadlines and internal concurrency assertions remain intact.

Actual desktop/mobile browser checks exercised finite policy setup, persistent enabled badge, no-driver unclaimed intent/expiry/cancel, kill cancelling unsubmitted intents, fixed action staging while policy disabled, registered key binding and executor archival. No executor key/driver was connected for browser verification, and no venue order was placed. [Actual policy screenshot](design/screenshots/pineterm-execution-policy.png) shows this explicit no-driver proof and disabled handoff.


## Install and run

Requirements: Node 24, npm, Docker daemon for isolated Pine execution. Run the API on the host; do not expose a Docker socket to a web container.

```sh
npm ci
cp .env.example .env
chmod 600 .env
# Edit .env: choose PINETERM_ADMIN_PASSWORD and generate the two secrets below.
openssl rand -base64 48   # PINETERM_SESSION_SECRET
openssl rand -base64 32   # PINETERM_SECRET_KEY (AES-256-GCM)
npm run runner:build
npm run dev
```

Open `http://127.0.0.1:5173` and use your configured administrator password. The development API defaults to `127.0.0.1:3000`; Vite proxies `/api` and WebSockets without replacing the browser Origin. No default password or registration exists.

```sh
npm run build
npm start
```

Production serves the built browser application and API on `http://127.0.0.1:3000`. Set `NODE_ENV=production` to require built assets at startup. Behind HTTPS, set `PINETERM_PUBLIC_ORIGIN` to the exact external origin; sessions then use Secure cookies. Default bind is loopback, not a public interface.

| Setting | Meaning |
| --- | --- |
| `PINETERM_ADMIN_PASSWORD` | Required administrator password; startup scrypt hash, no stored plaintext database password. |
| `PINETERM_SESSION_SECRET` | Required signing/CSRF material, at least 32 random bytes. |
| `PINETERM_SECRET_KEY` | Required canonical base64 encoding of exactly 32 random bytes; encrypts integration secrets. Back it up securely. |
| `PINETERM_DATA_DIR` | Persistent database/integration/session directory; default `./data`. |
| `PINETERM_HOST`, `PINETERM_PORT` | Default `127.0.0.1`, `3000`. Vite follows a custom port. |
| `PINETERM_PUBLIC_ORIGIN` | Production default `http://127.0.0.1:3000`; dev launcher defaults to `http://127.0.0.1:5173` if omitted. |
| `PINETERM_SOURCE_REVISION` | Optional exact deployed 40-character Git revision for source attribution; startup otherwise discovers Git HEAD. |

If port 3000 is occupied, use `PINETERM_PORT=3100 npm run dev`; for production use `PINETERM_PORT=3100 PINETERM_PUBLIC_ORIGIN=http://127.0.0.1:3100 npm start`. Do not stop unrelated services. Changing encryption keys without retaining the original makes existing encrypted secrets unreadable.

## API and security

[OpenAPI](http://127.0.0.1:3000/api/v1/openapi.json) contains full implemented route schemas. Errors have `{error:{code,message,details?}}`. Unknown command properties are rejected, not silently removed.

Session routes: `POST /api/v1/session` with `{password}`, `GET /api/v1/session` with the signed session cookie, and `DELETE /api/v1/session`. Browser mutations require the configured `Origin` and current `x-csrf-token`. Login has persisted per-source and global attempt limits; sessions expire after twelve hours. Cookies are HttpOnly/SameSite=Strict; session IDs and API tokens are stored hashed.

Issue API keys in **Settings**. Copy a token during its one-time display; the server cannot retrieve it afterward. Bearer keys cannot create keys or change security policy. Scopes: `market:read`, `scripts:read`, `backtests:run`, `paper:read`, `paper:trade`, `live:intent`, `executor:claim`, `executor:report`. Executor scopes bind to a registered executor selected in Settings. A key alone never enables live policy; claim/control/report also enforce its executor binding, and administrator sessions cannot impersonate reports.

Example for the currently available metadata API:

```sh
curl http://127.0.0.1:3000/api/v1/meta
curl http://127.0.0.1:3000/api/v1/openapi.json
```

`GET /api/v1/events` is an admin-session SSE stream of invalidation metadata only. Refetch authorized resources on reconnect. Database access stays in the server. SQLite uses WAL, foreign keys and numbered transactional migrations. Back up the data directory with SQLite-aware tooling; do not copy only a live database file while ignoring its WAL.

Keep `.env`, databases, agent logs, API/executor/model credentials and imported private data out of Git. The data directory is private by default. Do not put secrets in URLs or command-line arguments. Pi will have analysis/scripting authority only; future autonomous executor handoff requires a separately enabled policy.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run runner:build
npm run smoke:core
```

The core smoke starts real Fastify HTTP with temporary SQLite and deterministic providers, launches the restricted Docker runner, and invokes real scoped Node clients/local receivers/executables. Scenarios cover auth/data/workspace, Pine costs/equity/provenance/cancellation/deadline, paper/replay, durable alerts/HMAC, finance-client authorization and unknown-safe external handoff. The complete smoke and behavior suite passed after integration. Actual development/production browser checks cover charts, editor/results, paper/replay, alerts/notifications and finite execution-policy/kill surfaces. Screenshots are running-product evidence, not generated concepts.

## Integrations and simulation limits

Real Telegram bot/chat/user authorization, an operator-controlled HTTPS webhook receiver, model/provider credentials, and an operator-supplied sandbox execution driver are not configured. Notification configuration is implemented through Settings; no real-money order is part of verification. `PINETERM_SMOKE_URL=http://127.0.0.1:3200 npm run smoke:integrations` exercised explicit unconfigured Telegram/HTTPS prerequisites and exited nonzero, rather than fabricating acceptance.

`npm run smoke:integrations -- --telegram` requires an admin password securely in `PINETERM_SMOKE_ADMIN_PASSWORD` (or local `.env`). It checks real bot identity/outgoing test, then waits up to 120 seconds for an allowed operator `/status` acknowledgement. `--webhook` requires a configured HTTPS destination (`PINETERM_SMOKE_WEBHOOK_ID` if multiple) plus an operator-owned `PINETERM_SMOKE_WEBHOOK_RECEIPT_URL`; `?eventId=...` returns `{eventId,signatureVerified:true,receivedAt}` after original timestamp/raw-body HMAC validation. Optional receipt bearer token uses `PINETERM_SMOKE_RECEIPT_TOKEN`, never URL credentials. For dev, use Vite or set `PINETERM_SMOKE_ORIGIN` to the configured Origin.

`--executor` requires a **dedicated operator-owned exchange sandbox/testnet**, not the recorder: `PINETERM_SMOKE_EXECUTOR_ID/TOKEN/DRIVER/STATE`, optional `_DRIVER_ARGS` JSON array, and `_SANDBOX=true`. Explicitly prepare distinct `_FILL_INTENT_ID` (small market) and `_CANCEL_INTENT_ID` (non-marketable limit) under reviewed finite policy, with no unrelated active intents. The command never enables policy or chooses order size/markets. Read-only driver sandbox/testnet attestation precedes claim/submission; actual client cycles must observe a venue fill, status reconciliation and independently acknowledged cancellation. Operator driver/account credentials remain the missing prerequisite; `PINETERM_SMOKE_URL=http://127.0.0.1:3200 npm run smoke:integrations -- --executor` exercised the missing-prerequisite path and exited nonzero. No flags requests Telegram, HTTPS and executor checks; any failed/missing requested integration exits nonzero.

PineTS simulations are not TradingView-identical execution: upstream documents OCA sibling differences, approximate liquidation, absent FX conversion and numerical differences. Historical imports remain historical. USD and USDT, and different exchange venues, are distinct markets. Feed errors are reported, never silently replaced by another venue.

## License and attribution

Original PineTerm code: **AGPL-3.0-only**, see [LICENSE](LICENSE). [Corresponding source](https://github.com/KNN-07/PineTerm) is public; About links the deployed revision when available. Network deployments must satisfy AGPL source obligations.

Pinned dependencies: `@luxalgo/vela@0.8.0` (Apache-2.0), `@luxalgo/vela-pinets@0.2.14` and `pinets@0.10.0` (AGPL-3.0-only), `@earendil-works/pi-coding-agent@0.99.2` and `@earendil-works/pi-ai@0.99.2` (MIT). Preserve [Vela LICENSE](licenses/vela-LICENSE) and [NOTICE](licenses/vela-NOTICE); visible Vela attribution is required on chart screens. These dependencies confer no Vela Pro or LuxAlgo paid script-library rights. Their upstream authors retain ownership; PineTerm does not copy chart/runtime forks.

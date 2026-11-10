# sms-relay v0.1 — design

Date: 2026-11-09. Status: draft for approval.

## Intent

`sms-relay` is a small TypeScript backend on Cloudflare Workers. It receives the SMS that the
Android app `sms-forwarder` sends, stores each one once in D1, and forwards it to Telegram and/or
a signed webhook. Anyone can deploy it to their own Cloudflare account. It is a public portfolio
piece ("fullstack TypeScript · integrations, bots and automation") that sits next to
`sms-forwarder`, so it has to be real, small, well tested and honest about its limits.

## Goals

- Speak the exact contract that `sms-forwarder` already implements (read from its code, below).
- Never lose an accepted SMS. Never forward the same SMS twice because the phone retried.
- At-least-once delivery to each destination, with bounded retries and a visible final state.
- Deployable with one button or `wrangler deploy`, configured only through env vars and secrets.
- Logs that are safe to share: no SMS body, no sender, no tokens.

## Non-goals (v0.1)

- No UI. The read API is the only way to inspect stored messages.
- No multi-user or multi-tenant support. One deployment serves one owner.
- No destinations beyond Telegram and one webhook. No runtime-editable destinations.
- No replies to SMS and no outbound SMS.
- No rate limiting beyond what Cloudflare gives by default. Ingest needs a token.

## Anti-goals

- A response the app would misread. Examples: a 3xx, a 2xx other than 200, or a 4xx other than
  400/401/403 for a request that should be retried.
- A 400 for a payload the operator can fix on the server side. A 400 makes the app give up on
  that SMS, so the SMS is lost.
- Dependencies beyond Hono, Zod and Drizzle at runtime.
- Any text, data or logic taken from other private projects.

## The contract with sms-forwarder (verified in its source)

- `IngestPayload.encode` sends `{"sender": string, "body": string, "received_at": number}`.
  `received_at` is epoch ms (`dateSent` if present, else `date`). `body` is the joined multipart text.
- `IngestClient` sends `POST` with `Authorization: Bearer <token>` and
  `Content-Type: application/json; charset=utf-8`. It does not follow redirects.
- `classifyDelivery`: no response = retry. `200` (or any 2xx under `ANY_2XX`) = accepted.
  `3xx` = configuration error, terminal. `400`, `401`, `403` = rejected, terminal. The app reads
  `error` from a JSON body. Any other code = retry.
- `interpretConnectionTest` (onboarding): the app sends `{}`. `400` = OK, `401` = bad token, any
  other result = unreachable.
- `interpretDestinationTest` (destination screen): the STANDARD_JSON template is tested with `{}`.
  400 = OK, 401/403 = bad token. Other templates are tested with a sample SMS
  (`sender = "TEST"`, `received_at = now`) and must be accepted.
- Custom templates fill `{sender}`, `{body}`, `{received_at}` / `{received_at_ms}` (epoch ms),
  `{sim}` (number or empty) and `{device}` into a body the user writes. The JSON shape can vary.
- `SmsIdentity.localKey` = `SenderFilter.normalize(sender) + "|" + receivedAt + "|" + sha256hex(body)`.
  `SenderFilter.normalize` removes all whitespace and uppercases (`Locale.ROOT`).
- The app retries until it gets 200, and it also sweeps the inbox. Duplicates will arrive.

## Decisions

Decisions the user made are marked **(user)**. All other decisions are mine, marked **(my call)**,
because the user asked me to take the best decisions.

### HTTP surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/sms` | `INGEST_TOKEN` | Ingest one SMS |
| GET | `/v1/messages` | `READ_TOKEN` | List messages, newest first, cursor pagination |
| GET | `/v1/messages/:id` | `READ_TOKEN` | One message with its deliveries |
| GET | `/health` | none | `{"status":"ok"}` |

Any other path returns 404 `{"error":"not_found"}`. The Worker never returns 3xx **(user)**.

### Ingest: order of checks and response codes

1. **Configuration.** The Worker parses the env at the start of each request. If `INGEST_TOKEN` is
   missing or shorter than 32 characters, it returns `503 {"error":"not_configured"}`. If a
   destination is half configured or a filter regex does not compile, it returns
   `503 {"error":"config_invalid"}`. **(my call)** 503 makes the app keep the SMS and retry. After
   the operator fixes the config, nothing is lost. A 401 here would make the app drop every SMS.
   The trade-off: the onboarding test shows "unreachable" instead of "OK". The README explains
   this.
2. **Auth.** The `Authorization` header must be `Bearer <token>`. The Worker compares SHA-256
   digests of both values with `crypto.subtle.timingSafeEqual`, so the time does not depend on
   length or content. A missing or wrong token returns `401 {"error":"unauthorized"}` **(user)**.
   The Worker never returns 403 on ingest.
3. **Size.** The raw body must be at most 64 KiB, measured on the bytes read, not only on
   `Content-Length`. Over the limit: `400 {"error":"payload_too_large"}`. **(my call)** 413 is
   not in the app's terminal set, so the app would retry a request that can never succeed.
4. **Parse.** The Worker reads the body as text and parses it as JSON, whatever the
   `Content-Type`. Custom templates can send JSON as `text/plain`. Invalid JSON:
   `400 {"error":"invalid_json"}`.
5. **Validate** (Zod). Failure: `400 {"error":"validation_failed","message":"<field>: <reason>"}`.
   The message names fields only and never echoes values. `{}` lands here, so the connection
   test gets its 400 **(user)**.
6. **Store and dedup** (see below). New: `200 {"status":"stored","id":<n>}`. Duplicate:
   `200 {"status":"duplicate","id":<n>}` **(user)**.
7. **Unexpected error** (for example D1 unavailable): `500 {"error":"internal"}`. The app retries.

All error bodies are `{"error": "<code>", "message": "<English text>"}`. `error` is a stable
snake_case code.

### Payload schema

| Field | Rule |
|---|---|
| `sender` | string. Trimmed, 1–64 characters. Must not be empty after normalization. **(user)** |
| `body` | string, 1–10 000 characters. **(my call, see below)** |
| `received_at` | One of: integer epoch ms; a string of digits (epoch ms); an ISO 8601 string with `Z` or an offset **(user)**. ISO without a zone is rejected, because it is ambiguous. The value must be between 2000-01-01 and now + 24 h. |
| `sim` | optional: integer 0–15, a digit string of the same (custom templates quote `{sim}`), `null`, or `""` (the app renders an unknown slot as empty). **(my call)** |
| `device` | optional string, up to 64 characters. **(my call)** |

Unknown keys are dropped. **(my call)** A custom template that adds fields must not be rejected
for them.

**Why 10 000 for `body`.** A 400 is a permanent loss, so the limit must sit well above any real
SMS. A concatenated SMS of 10 parts is about 1 530 GSM-7 characters or 670 UCS-2 characters.
Carriers rarely go past 10 parts, and the standard maximum (255 parts) is about 39 000 GSM-7
characters. 10 000 covers every realistic message, keeps a D1 row small, and limits abuse
through a leaked token. Telegram has its own limit of 4 096 characters per message. The Worker
cuts the Telegram text to fit and stores the full body.

**Digit strings for `received_at`.** A user who writes `"received_at":"{received_at}"` in a
custom template sends the number as a string. Accepting it costs one line and saves a
permanent 400.

### Dedup

- `normalizeSender(s)` = remove every character that Kotlin `Char.isWhitespace` counts
  (JVM: `Character.isWhitespace || Character.isSpaceChar`), then `toUpperCase()`. In JS that is
  `/[\t\n\v\f\r\u001C-\u001F\p{Zs}\p{Zl}\p{Zp}]/gu`. JS `\s` is not used, because it also
  matches U+FEFF, which Kotlin keeps. JS `toUpperCase` does not depend on the locale, which
  matches `Locale.ROOT`. A test pins the known cases: spaces, tabs, NBSP, U+FEFF kept, `+`,
  letters, `ß` → `SS`.
- `dedup_key = sha256hex(normalizeSender(sender) + "|" + received_at_ms + "|" + sha256hex(body))`
  **(user)**. This is the app's `localKey`, hashed again. With ISO input, the Worker converts to
  epoch ms first. The same instant in two formats is the same SMS.
- `messages.dedup_key` has a unique index. The insert uses `ON CONFLICT(dedup_key) DO NOTHING
  RETURNING id`. No returned row means a duplicate, so the Worker reads the existing id. Two
  concurrent requests cannot both create a row.
- A duplicate never creates new deliveries. This holds also when an earlier delivery failed.
- The destination test of a non-standard template sends a sample SMS (`TEST`, `now`). The Worker
  stores and forwards it like any other SMS. **(my call)** That is the end-to-end proof the user
  wants from a test. Each test has a new `received_at`, so each test is a new message.

### Storage (D1 + Drizzle)

`messages`

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK autoincrement | public id |
| `dedup_key` | text, unique, not null | |
| `sender` | text, not null | as received, trimmed |
| `body` | text, not null | |
| `received_at` | integer, not null | epoch ms |
| `sim` | integer, null | |
| `device` | text, null | |
| `created_at` | integer, not null | epoch ms, server time |
| `ingest_nonce` | text, not null | random per request; links the deliveries insert to the request that created the row |

Index: `created_at` (retention), and `id` order for listing.

`deliveries`

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK autoincrement | |
| `message_id` | integer, FK `messages.id` ON DELETE CASCADE | |
| `destination` | text: `telegram` \| `webhook` | |
| `status` | text: `pending` \| `delivered` \| `failed` | |
| `attempts` | integer, default 0 | |
| `next_attempt_at` | integer, not null | epoch ms |
| `locked_until` | integer, null | lease, see outbox |
| `last_error` | text, null | short code such as `http_502`, `timeout`, `network`, `http_400` |
| `last_status_code` | integer, null | |
| `delivered_at` | integer, null | |
| `created_at`, `updated_at` | integer, not null | |

Indexes: `(status, next_attempt_at)` for the cron scan. `UNIQUE(message_id, destination)`.

Migrations are generated by drizzle-kit into `drizzle/`. Tests apply them in the Workers test
runtime with `readD1Migrations` + `applyD1Migrations`.

**Public ids are sequential integers. (my call)** One owner per deployment and a token on the read
API, so the count they reveal is not sensitive. They make the cursor simple.

### Outbox and delivery

- In the same D1 `batch` as the message insert, the Worker inserts one `pending` delivery for
  each destination that is configured and whose filter matches **(user)**. The deliveries
  insert is `INSERT … SELECT id FROM messages WHERE dedup_key = ? AND ingest_nonce = ?`. The
  nonce matches only when this request created the message. The batch is one transaction, so a
  message never exists without its deliveries, and a duplicate never adds deliveries. If the filter does
  not match, the Worker inserts no row. **(my call)** Fewer states. The README says that a
  filtered destination does not appear in `GET /v1/messages/:id`.
- After the 200 response, the Worker runs `ctx.waitUntil(processDeliveries(ids))` for an
  immediate attempt **(user)**.
- **Lease.** Before it sends, a worker claims the row:
  `UPDATE deliveries SET locked_until = now + 60s WHERE id = ? AND status = 'pending'
  AND next_attempt_at <= now AND (locked_until IS NULL OR locked_until < now) RETURNING *`.
  Only the worker that claims the row sends it. The immediate attempt and the cron cannot send
  the same delivery at the same time. If a worker dies during a send, the lease expires and the
  cron takes the row again. This is the at-least-once case. Receivers deduplicate on
  `X-Delivery-Id` (webhook). Telegram can show the message twice in this rare case. The README
  lists it under known limits.
- **Classification of a destination response (my call):**
  - 2xx: `delivered`.
  - 408, 425, 429, 5xx, timeout (10 s, `AbortSignal.timeout`), network error: retry.
  - 3xx: `failed`, `last_error = "redirect"`. Fetch uses `redirect: "manual"`, so the signature
    and the body are not sent again to another host.
  - Any other 4xx: `failed` at once. Telegram 400 `chat not found` and 401 `Unauthorized` do not
    get better with retries.
- **Backoff (user: exponential, with a limit).** After failed attempt `n`, the next attempt is at
  `now + min(60 s × 2^(n-1), 1 h)`: 1, 2, 4, 8, 16, 32 min, then 1 h. If the response has
  `Retry-After` (webhook) or `parameters.retry_after` (Telegram 429), the Worker uses the
  larger of that value and the backoff, capped at 1 h. There is no jitter. **(my call)** One
  owner, few rows, and the tests stay deterministic. After `MAX_ATTEMPTS` (default 10, about
  4 h 3 min in total) the status is `failed`.
- **Cron `* * * * *` (user).** Each run (1) applies retention, then (2) selects at most 50 due
  `pending` deliveries (`next_attempt_at <= now`, lease free), oldest first, and processes them
  with a concurrency of 5. **(my call)**

### Telegram

- `POST https://api.telegram.org/bot<token>/sendMessage` with plain fetch **(user)**. The base
  URL comes from `TELEGRAM_API_BASE` (default as above), so tests can point it at a fake.
- Text, no `parse_mode` **(my call)**. With no parse mode, no escaping is needed and an SMS
  cannot break the formatting:

  ```
  SMS from <sender>
  <received_at in DISPLAY_TIMEZONE, "2026-11-09 14:03 UTC" style>

  <body>
  ```

  The text is cut to 4 096 characters and ends with `…` when cut.
- `link_preview_options: {is_disabled: true}` **(my call)**. SMS often contain phishing links,
  and Telegram must not fetch them.
- `DISPLAY_TIMEZONE` is an IANA name, default `UTC`. The Worker validates it with
  `Intl.DateTimeFormat`. An invalid name is a config error (503 on ingest).

### Webhook

- `POST WEBHOOK_URL`, `Content-Type: application/json`. Body:

  ```json
  {
    "event": "sms.received",
    "delivery_id": 12,
    "message": {
      "id": 7,
      "sender": "+15551234567",
      "body": "…",
      "received_at": "2026-11-09T14:03:21.000Z",
      "received_at_ms": 1762697001000,
      "sim": 1,
      "device": "Pixel 6"
    }
  }
  ```

- Headers: `X-Timestamp: <unix seconds>`, `X-Delivery-Id: <delivery id>`,
  `X-Signature: sha256=<hex>`.
- **Signature (my call, a change from the request).** The request asked for an HMAC of the body.
  The Worker signs `<X-Timestamp> + "." + <raw body>` with HMAC-SHA256 and `WEBHOOK_SECRET`. If
  only the body were signed, an attacker who captured one request could send it again with a
  new `X-Timestamp`, and the receiver could not detect it. The README shows how to verify the
  signature in Node: constant-time compare, and reject a timestamp more than 5 minutes old.
- `WEBHOOK_URL` must be `https:`. The one exception is `http://localhost` or `http://127.0.0.1`
  for local development **(my call)**. Any other value is a config error.
- `WEBHOOK_SECRET` must be at least 32 characters.

### Filters per destination

- `TELEGRAM_SENDERS`, `WEBHOOK_SENDERS`: comma-separated list. The match is exact on the
  normalized sender, the same as `SenderFilter.matches` in the app.
- `TELEGRAM_SENDER_REGEX`, `WEBHOOK_SENDER_REGEX`: a JS regex, flag `i`, tested on the sender as
  received.
- Rule: if neither is set, everything passes. If one or both are set, the sender passes when it
  matches the list **or** the regex. **(my call)**
- The regex comes from the operator's own config, so ReDoS is out of scope. The README says to
  keep the pattern simple.

### Read API

- `READ_TOKEN` must be configured (at least 32 characters) and must be different from
  `INGEST_TOKEN`. If it is missing or equal, the read routes return 503 `not_configured`
  **(my call)**. A token that leaks from the phone must not open the archive. The auth is the
  same constant-time check. Wrong or missing token: 401.
- `GET /v1/messages?limit=&cursor=`: `limit` 1–100, default 50. Order: `id` descending.
  `cursor` is opaque (base64url of the last id). A bad cursor or limit returns
  `400 validation_failed`. Response:
  `{"messages":[{id, sender, body, received_at, sim, device, created_at, deliveries:[{destination,status}]}], "next_cursor": string|null}`.
  Timestamps are ISO 8601 UTC strings.
- `GET /v1/messages/:id`: the message plus full deliveries (`destination`, `status`,
  `attempts`, `last_error`, `last_status_code`, `next_attempt_at`, `delivered_at`). An unknown
  id or one that is not a number returns 404 `not_found`.

### Retention

- `RETENTION_DAYS`, default 30. `0` means keep forever **(user: configurable)**.
- The cron deletes messages with `created_at < now − N days`, at most 500 per run. **(my call)**
  This keeps each run short. Deliveries go with the cascade, and the code also deletes them
  explicitly in the same batch, so the result does not depend on the FK setting.
- Messages with a pending delivery are kept until the delivery ends.
- **Known effect:** the dedup key is deleted together with the message. If the phone sends an
  SMS again after it was purged, the SMS is stored and forwarded again. The README says so.

### Configuration

| Name | Kind | Default | Notes |
|---|---|---|---|
| `INGEST_TOKEN` | secret | — | required, at least 32 characters |
| `READ_TOKEN` | secret | — | required for the read API, at least 32 characters, different from `INGEST_TOKEN` |
| `TELEGRAM_BOT_TOKEN` | secret | — | Telegram is on when this and `TELEGRAM_CHAT_ID` are both set. Only one of them set is a config error. |
| `TELEGRAM_CHAT_ID` | var | — | numeric id or `@channel` |
| `TELEGRAM_SENDERS`, `TELEGRAM_SENDER_REGEX` | var | — | filter |
| `WEBHOOK_URL` | var | — | the webhook is on when this and `WEBHOOK_SECRET` are both set |
| `WEBHOOK_SECRET` | secret | — | at least 32 characters |
| `WEBHOOK_SENDERS`, `WEBHOOK_SENDER_REGEX` | var | — | filter |
| `RETENTION_DAYS` | var | `30` | integer ≥ 0 |
| `MAX_ATTEMPTS` | var | `10` | integer 1–50 |
| `DISPLAY_TIMEZONE` | var | `UTC` | IANA |
| `TELEGRAM_API_BASE` | var | `https://api.telegram.org` | for tests |

`.dev.vars.example` lists all of them with placeholder values only **(user)**. The Deploy to
Cloudflare button reads it to ask for the secrets.

The config is parsed with Zod into one typed `Config` object, once per request or cron run.
Nothing else reads `env` directly.

### Logging

- One JSON line per event, through `log(event, fields)`. Examples: `ingest.stored`,
  `ingest.duplicate`, `ingest.rejected` (with `error` code), `delivery.delivered`,
  `delivery.retry`, `delivery.failed`, `retention.purged`, `config.invalid` (with the variable
  name, never its value).
- Allowed fields: ids, destination, status codes, error codes, attempt numbers, counts and
  durations. `log` takes a typed field object with no free-text value, so a sender or a body
  cannot be passed to it **(user: never log body, sender or tokens)**.
- A test runs a full ingest and delivery cycle with `console` spied and checks that no log line
  contains the sender, the body or any token.

### Code layout (guide for the builder)

```
src/
  index.ts            Worker entry: fetch (Hono app) + scheduled
  app.ts              Hono app, routes, error handler
  config.ts           env → Config (Zod), config errors
  http/auth.ts        bearer + constant-time compare
  http/errors.ts      error codes, JSON error helper
  ingest/schema.ts    payload schema, received_at parsing
  ingest/identity.ts  normalizeSender, dedup key
  ingest/handler.ts   POST /v1/sms
  read/handler.ts     GET /v1/messages[/:id], cursor
  outbox/backoff.ts   pure backoff + classification
  outbox/process.ts   lease, send, update state
  destinations/telegram.ts
  destinations/webhook.ts   payload + HMAC signature
  destinations/filter.ts
  retention.ts
  db/schema.ts        Drizzle tables
  db/repo.ts          queries
  log.ts
test/  unit/ and integration/ (SELF.fetch, scheduled), helpers, migrations setup
```

Outbound HTTP goes through a `fetch` function passed into the destination senders. Tests pass in
a fake that records requests and returns scripted responses. The tests do not depend on a mock
API of the test runtime.

### Quality

- TDD **(user)**. Tests run in the Workers runtime (`@cloudflare/vitest-plugin` 1.4.0), with a
  real local D1.
- Required test areas **(user)**: auth (missing, wrong, right, not configured, timing-safe path),
  validation (each field and boundary, ISO and offsets), dedup (same SMS, ISO vs ms, whitespace
  and case in sender, concurrent inserts), the app contract (`{}` → 400; wrong token → 401;
  never a 3xx; only 200 on success, also for a duplicate; 400 bodies carry `error`), outbox
  (immediate attempt, lease, retry, final failed, no new deliveries for a duplicate), backoff
  (pure function table), HMAC signature (a known test vector), retention, filters, read API
  pagination, and logs that carry no secrets.
- Coverage thresholds in `vitest.config.ts`: lines and statements 95, functions 95,
  branches 90, on `src/**` except `src/index.ts`. **(my call)**
- `npm run verify` = `tsc --noEmit` + `vitest run --coverage` **(user)**.
- CI: GitHub Actions on push and PR to `main`, Node 24, `npm ci`, `npm run verify`. Actions are
  pinned by full commit SHA with the version in a comment. Permissions: `contents: read`.
  Concurrency cancels older runs **(user)**.
- Exact versions **(user)**: hono 4.13.13, zod 4.6.5, drizzle-orm 0.45.4, drizzle-kit 0.31.11,
  wrangler 4.149.0, typescript 5.9.3 (strict), vitest 4.1.11, @cloudflare/vitest-plugin 1.4.0,
  @vitest/coverage-istanbul 4.1.11. Node ≥ 24.

### README (English) **(user)**

What it is. A Mermaid diagram (sms-forwarder → Worker → D1 → Telegram / webhook, with the cron
retry loop). The API contract with every status code and error code. How to point sms-forwarder
at the Worker (URL `https://<worker>/v1/sms`, the token, what the connection test shows). Deploy
with wrangler (`d1 create`, migrations, `secret put`) and with the Deploy to Cloudflare button.
Webhook signature verification with a Node example. Known limits. CI badge and MIT license.

Known limits to list: at-least-once delivery (a rare duplicate on Telegram after a crashed send);
no re-forwarding of an SMS after retention purges it; one owner; Telegram text cut at 4 096
characters; the onboarding test shows "unreachable" while the server is not configured; only
one webhook; no rate limiting.

### Repo

- Branch `main`, MIT, future remote `Lacho00/sms-relay` (public) **(user)**.
  No GitHub repo, no push and no deploy without asking first.
- `.gitignore`: `node_modules/`, `.wrangler/`, `.dev.vars`, `coverage/`, `.codebase-memory/`.
- Conventional, small commits. No attribution lines. OCR review before any push or PR **(user)**.
- Own code from scratch. Nothing copied from other projects, and no names of companies, clients
  or local domains.

## Left to the builder

- Exact Hono middleware structure, helper names, Drizzle query style.
- Wording of English error messages (codes are fixed above).
- `wrangler.jsonc` compatibility date: a recent date that the pinned Wrangler supports.

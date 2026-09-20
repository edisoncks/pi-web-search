# pi-web-search — Behavioral Specification

|                           |                                                               |
| ------------------------- | ------------------------------------------------------------- |
| **Specification version** | the package version (see the constants block in §9)           |
| **Status**                | Normative for the shipped implementation                      |
| **Audience**              | Contributors maintaining, extending, or reviewing the package |

This document defines **what `pi-web-search` does** — the observable contract:
tool definitions, wire requests, parsing rules, output bytes, limits, and error
strings. It does **not** walk through the source line by line; that is what the
code and the behavior tests are for. Internal structure is described in
[ARCHITECTURE.md](./ARCHITECTURE.md).

The keywords **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used as in
RFC 2119.

> **External contracts drift.** The Exa MCP endpoint, the Obscura CLI, and the
> DuckDuckGo Lite markup are third-party surfaces. The committed fixtures and
> the behavior tests (see §11) are the executable truth; if they disagree with
> this prose, the fixtures win and this document is wrong.

---

## 0. Runtime requirements

- **Node `>=22.19.0`** (`engines.node`, required by the Pi host peer
  dependency). `getRequestSignal` additionally guards for
  `AbortSignal.timeout`/`AbortSignal.any` and throws `UnsupportedRuntimeError`
  with the message
  `pi-web-search requires Node >=22.19.0 (AbortSignal.timeout/any is unavailable)`.
  This is an environment fault, not a provider fault: both provider wrappers
  rethrow it unchanged (§6.7, §7.11) rather than framing it as an Exa or
  DuckDuckGo outage.
- `EXA_API_KEY` is optional (§6.3).
- `obscura` on `PATH` is required only for the DuckDuckGo provider (§7.1).

---

## 1. Overview

The extension registers exactly two LLM-callable tools:

1. **`web_search_exa`** — primary provider, JSON-RPC/MCP over HTTPS. No
   external binary.
2. **`web_search_ddg`** — fallback, scraping DuckDuckGo Lite through the
   external `obscura` CLI.

Provider policy (**Exa first, DuckDuckGo only on failure or explicit request**)
is enforced through the system prompt, not code. It lives in the tool
`description`, `promptSnippet`, and `promptGuidelines` strings (§3), which MUST
be reproduced verbatim.

Both tools share one `DuckDuckGoState` instance, created once at extension
load.

---

## 2. Module layout and public API

The package's **only** public API is the default export of `index.ts`, the
extension factory `(pi: ExtensionAPI) => void`. There are no named exports;
`tests/api-surface.test.ts` fails if one is added. Everything else is internal
and imported directly by tests:

| Module              | Responsibility                                                             |
| ------------------- | -------------------------------------------------------------------------- |
| `lib/types.ts`      | Constants and interfaces. No imports.                                      |
| `lib/params.ts`     | `normalizeSearchParams` and the TypeBox parameter schema.                  |
| `lib/filter.ts`     | Domain normalization and matching.                                         |
| `lib/policy.ts`     | Rate limiting, cache, breaker, request serialization, dedup, signals.      |
| `lib/format.ts`     | Numbered result blocks and Pi-host output truncation.                      |
| `lib/tools.ts`      | Tool metadata, execute wiring, and the injected provider interface.        |
| `lib/version.ts`    | `PACKAGE_VERSION`, read from `package.json` at runtime.                    |
| `lib/exa.ts`        | Exa MCP transport and result shaping.                                      |
| `lib/duckduckgo.ts` | Obscura fetch and DuckDuckGo Lite parsing.                                 |
| `index.ts`          | The extension factory: shared DuckDuckGo state + `registerWebSearchTools`. |

---

## 3. Tool definitions

Both tools are registered with the strings below. Every string is normative.

### 3.1 `web_search_exa`

| Field              | Value                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | `web_search_exa`                                                                                                                                                                                                                                                                                  |
| `label`            | `Web Search (Exa)`                                                                                                                                                                                                                                                                                |
| `description`      | `Primary web search provider. Use web_search_exa first for current information and relevant sources. If Exa reports a quota, rate-limit, or provider error, call web_search_ddg instead; do not retry Exa immediately.`                                                                           |
| `promptSnippet`    | `Search the web with Exa as the primary provider`                                                                                                                                                                                                                                                 |
| `promptGuidelines` | `["Use web_search_exa first when the user needs current information or web sources.", "If web_search_exa reports an error, call web_search_ddg instead of retrying Exa immediately.", "Do not call web_search_exa and web_search_ddg for the same query unless the user requests a comparison."]` |
| `parameters`       | §3.3                                                                                                                                                                                                                                                                                              |
| `execute`          | normalize params (§4) → `searchExaForTool` (§6) → `formatSearchToolResult("exa", result)` (§8)                                                                                                                                                                                                    |

### 3.2 `web_search_ddg`

| Field              | Value                                                                                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | `web_search_ddg`                                                                                                                                                                                                                               |
| `label`            | `Web Search (DuckDuckGo)`                                                                                                                                                                                                                      |
| `description`      | `Fallback web search provider using DuckDuckGo Lite through Obscura. Only use web_search_ddg when web_search_exa reports an error or when the user explicitly requests DuckDuckGo. Do not use it for routine searches while Exa is available.` |
| `promptSnippet`    | `Search the web with DuckDuckGo only after Exa fails`                                                                                                                                                                                          |
| `promptGuidelines` | `["Use web_search_ddg only after web_search_exa reports an error or when the user explicitly requests DuckDuckGo.", "Do not use web_search_ddg as the first provider for routine searches."]`                                                  |
| `parameters`       | §3.3                                                                                                                                                                                                                                           |
| `execute`          | normalize params (§4) → `searchDuckDuckGoForTool(params, state, signal)` (§7) → `formatSearchToolResult("duckduckgo", result)` (§8)                                                                                                            |

### 3.3 Parameter schema (both tools)

| Field             | Type     | Constraints                 | Default  |
| ----------------- | -------- | --------------------------- | -------- |
| `query`           | string   | `minLength: 2`              | required |
| `allowed_domains` | string[] | each item `minLength: 1`    | absent   |
| `blocked_domains` | string[] | each item `minLength: 1`    | absent   |
| `numResults`      | integer  | `minimum: 1`, `maximum: 20` | `8`      |

Schema descriptions (shown to the LLM):

- `query`: `Search query, at least two characters long`
- `allowed_domains`: `Only return results from these domains`
- `blocked_domains`: `Exclude results from these domains`
- `numResults`: `Maximum number of results to return (default: 8)`

---

## 4. Parameter normalization

Given raw `WebSearchParams`:

1. `query = raw.query.trim()`. If `query.length < 2`, throw
   `Search query must be at least 2 characters long`.
2. `numResults = raw.numResults ?? 8`. If it is not an integer, or `< 1`, or
   `> 20`, throw `numResults must be an integer between 1 and 20`.
3. `allowedDomains = normalizeDomains(raw.allowed_domains)` (§5).
4. `blockedDomains = normalizeDomains(raw.blocked_domains)` (§5).

The result is a `NormalizedSearchParams` with all four fields populated.

---

## 5. Domain handling

- **`normalizeDomain`**: trim; parse as a URL (prefix `https://` when there is no
  `://`); take the lowercased hostname, stripping one trailing `.`. An empty
  hostname or parse failure throws `Invalid domain: <value>`. Examples:
  `Example.COM ` → `example.com`; `example.com/foo` → `example.com`.
- **`normalizeDomains`**: `undefined`/`[]` → `[]`. Every entry MUST be
  non-blank, else throw `Invalid domain: <value>` — a whitespace-only entry
  must never silently disable filtering. Return the deduplicated, first-seen
  order list of normalized hosts.
- **`hostnameOf`**: tolerant parsing for matching only; strips a leading `//`,
  prefixes `https://` when needed, lowercases and strips one trailing `.`.
  Returns `undefined` on failure.
- **`isDomainMatch(url, domains)`**: true iff `hostname === domain ||
hostname.endsWith("." + domain)` for some domain; false when the list is empty
  or the host is unparseable. Matching is strict — `evil-example.com` does
  **not** match `example.com`.

**Filter authority:**

- Exa with filters present uses the server-side advanced tool; structured
  results are additionally filtered client-side with `isDomainMatch`.
- DuckDuckGo filters client-side only; query `site:` operators (§7.2) are hints.
- Unstructured Exa text reports `resultCount: 0` rather than guessing (§6.6).

---

## 6. Exa provider

### 6.1 Endpoint and tool selection

- Base URL `https://mcp.exa.ai/mcp`.
- The request URL carries `?tools=`: `web_search_advanced_exa` when
  `allowedDomains` or `blockedDomains` is non-empty, else `web_search_exa`.

### 6.2 JSON-RPC handshake

The handshake is performed **once per session**, not once per search. The
session id returned by `initialize` is cached per endpoint URL (the URL carries
`?tools=`, so the primary and advanced tools have separate sessions) and reused
by later searches.

Establishing a session is three POSTs in order to the same endpoint URL:

1. **`initialize`** (`id: 1`):

   ```json
   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "initialize",
     "params": {
       "protocolVersion": "2025-03-26",
       "capabilities": {},
       "clientInfo": { "name": "pi-web-search", "version": "<package version>" }
     }
   }
   ```

   `clientInfo.version` is `PACKAGE_VERSION` (§9) — never a literal.

2. **`notifications/initialized`** — no `id`, sent with the session id from step
   1: `{ "jsonrpc": "2.0", "method": "notifications/initialized" }`.
3. **`tools/call`** (`id: 2`) with `params.name` equal to the selected tool and
   `params.arguments` containing `query` and `numResults`. For the advanced
   tool it additionally contains `includeDomains` (only when
   `allowedDomains` is non-empty), `excludeDomains` (only when
   `blockedDomains` is non-empty), and `textMaxCharacters: 1000`.

After a session is established, a search is a single `tools/call`. If a call
that reused a **cached** session fails with **HTTP 404** — the status the MCP
transport spec mandates for an unknown or expired `Mcp-Session-Id` — the
session id is discarded, the handshake is repeated once, and the call is
retried once. No other failure is retried: a freshly established session, an
aborted caller, a JSON-RPC error, or any non-404 HTTP status fails immediately.
A server that returns no session id is not cached (so it is re-initialized on
every search, as before).

### 6.3 Request headers

| Header                 | Value                                                  |
| ---------------------- | ------------------------------------------------------ |
| `Accept`               | `application/json, text/event-stream`                  |
| `Content-Type`         | `application/json`                                     |
| `x-exa-source`         | `pi-web-search`                                        |
| `x-api-key`            | `process.env.EXA_API_KEY?.trim()`, only when non-empty |
| `Mcp-Session-Id`       | session id, only when known                            |
| `MCP-Protocol-Version` | `2025-03-26`, only when a session id is sent           |

The request signal is the caller's signal plus a 15 s timeout. The response's
`mcp-session-id` header, when present, becomes the session id for later
requests. `EXA_API_KEY` is **warn-and-try**: anonymous use is attempted, and
only an actual HTTP 401/403 produces a key hint (§6.7).

### 6.4 Response parsing

Given the raw body and optional `content-type`:

1. Empty body → `{}` (the 202 notification response).
2. `looksSSE` = content-type matches `text/event-stream`, **or** the body has a
   line beginning `event:`/`data:`.
3. Parse as SSE when `looksSSE`, else as JSON; on failure, fall back once to
   the other and throw
   `Exa MCP response parsed neither as JSON (…) nor as SSE fallback` (or the
   SSE-first equivalent).
4. A parsed payload that is not a record (an array is not a record) throws
   `Exa MCP returned an invalid JSON-RPC response`.

**Critical invariant:** a JSON body that merely _contains_ `data:` (for example
a result about the `data:` URL scheme) MUST be routed to the JSON parser. The
check keys on the content-type and on `data:`/`event:` at the **start of a
line**, never an anywhere-occurrence.

### 6.5 SSE parsing

Split blocks on `\r?\n\r?\n`; collect `data:` lines (strip prefix and one
optional space), join with `\n`, trim, drop empties. `JSON.parse` candidates
**last to first**; the final JSON-RPC frame is the result. If none parse, throw
`Exa MCP returned an invalid SSE response`.

### 6.6 Result shaping

1. `isError` → throw the tool text, or `Exa MCP search failed` when empty.
2. `rawText`: `content[]` entries whose `type` is `"text"` or absent, non-empty,
   joined by `\n\n`, trimmed; else `JSON.stringify(structuredContent)`; else
   `""`.
3. Try to parse `rawText` as a record with a `results` array. For each item
   with a non-empty string `url`, emit `{ title, url, snippet }` where
   `title` is the whitespace-collapsed `item.title` or `url`, and `snippet` is
   the first available of `item.summary`, joined non-empty `highlights`,
   `item.text`, else `""`, whitespace-collapsed.
4. When structured results parse: drop `blockedDomains`, keep only
   `allowedDomains` when non-empty, truncate to `numResults`, and return
   `formatNumberedResults("Exa", filtered)` with `resultCount = filtered.length`.
5. Otherwise return the raw text under a `Web search results (provider: Exa):`
   header (or the empty-results line) with `resultCount: 0`. Never guess the
   count from body content.

### 6.7 Error mapping

- Non-2xx: `Exa MCP returned HTTP <status>[: <body ≤ 300 chars>]`.
- JSON-RPC error: `Exa MCP error (<code>): <message>` (code omitted when
  absent; message defaults to `unknown error`).
- Missing result: `Exa MCP returned no tool result`.
- `searchExaForTool` rewrites failures unless the caller's signal aborted or
  the failure is `UnsupportedRuntimeError` (§0):
  - HTTP 401/403 → `Exa web search is unavailable (<detail>). Set EXA_API_KEY to use Exa, or call web_search_ddg for this search instead; do not retry web_search_exa immediately.`
  - quota/rate-limit → `Exa quota or rate limit was reached (<detail>). Call web_search_ddg for this search instead; do not retry web_search_exa immediately.`
  - otherwise → `Exa web search is unavailable (<detail>). …` (same tail).

The quota/rate-limit classification matches `quota`, `rate limit`, `too many
requests`, `HTTP 429`, or `usage limit` (case-insensitive). The bare word
`exceeded` is deliberately not a trigger, so an unrelated "response size
exceeded" is reported as a generic Exa failure, not a quota problem.

`<detail>` is `shortErrorMessage` (whitespace-collapsed, ≤ 300 chars). Aborts
are never rewritten into provider errors.

---

## 7. DuckDuckGo provider

### 7.1 Transport

- Target `https://lite.duckduckgo.com/lite`, fetched by spawning:

  ```sh
  obscura --stealth fetch <lite-url-with-q> --dump html --quiet --wait 0 --timeout 15
  ```

- `execFile` options: `encoding: "utf8"`, `maxBuffer: 4 * 1024 * 1024`, plus
  the combined request signal (the caller's signal combined with
  `AbortSignal.timeout(15000)`). The signal is the single Node-side timeout;
  there is no separate `execFile` `timeout` racing it. The `--timeout 15` argv
  flag is Obscura's own fetch bound.
- Empty/whitespace stdout throws `Obscura returned empty DuckDuckGo HTML`.

### 7.2 Query construction

Parts joined by single spaces, then URL-encoded into `q`:

1. the raw `query`;
2. when `allowedDomains` is non-empty, `(site:a.com OR site:b.com)`;
3. one `-site:<domain>` per `blockedDomains` entry.

These operators are hints; authoritative filtering is §5.

### 7.3 HTML parsing

Normalize the domain filters (§5); find anchors whose `class` contains
`result-link`; resolve each `href` via §7.4; drop unusable and duplicate URLs.
The section from an anchor's end to the next matching anchor supplies the first
`result-snippet` cell. Apply domain filtering, then emit
`{ title: stripHtml(anchorText), url, snippet }` (§7.5).

### 7.4 URL resolution

Decode entities, parse against `https://duckduckgo.com`. With `uddg`, parse its
value and reject non-`http(s)` targets and `duckduckgo.com`/`*.duckduckgo.com`.
Without `uddg`, reject DDG-hosted and non-`http(s)` links (never surface DDG
self-links). Any failure → `undefined`. Host matching is strict:
`notduckduckgo.com` is preserved.

### 7.5 Entity decoding and stripping

`decodeHtmlEntities` handles hex `&#xHH;`, decimal `&#DDD;`, and the named set
`amp, apos, gt, lt, nbsp, quot` (case-insensitive); unknown entities are left
untouched. `stripHtml` removes `<script>`/`<style>` contents, turns `<br>` into
a space, replaces remaining tags with a space, decodes entities, then collapses
whitespace and trims.

### 7.6 Classification

Decided on the **unfiltered** extraction, in order:

1. ≥ 1 extracted result → `{ kind: "results", results }` (filters applied to the
   emitted set). Filtering every result away is an empty success, never `drift`.
2. `detectDuckDuckGoChallenge(html)` matches
   `/challenge-form|anomaly|captcha|Unfortunately, bots use DuckDuckGo/i` →
   `{ kind: "challenge", reason: "DuckDuckGo returned an anti-bot challenge page" }`.
3. HTML contains `uddg=` → `{ kind: "drift" }`.
4. Else `{ kind: "empty" }`.

The challenge detector MUST only be consulted when zero results were extracted,
so snippet text cannot trip the breaker.

### 7.7 Failure semantics

- **Challenge** → `markDuckDuckGoUnavailable` (10–15 min) and throw
  `DuckDuckGoUnavailableError(reason, retryAt)`.
- **Drift** → throw `DuckDuckGoDriftError` with
  `DuckDuckGo returned results but none could be parsed; its markup likely changed. Use web_search_exa for this search.`
  Deterministic: no retry, no cooldown, no spacing penalty.
- **Empty** → success with zero results.

### 7.8 Retry policy

At most one retry (two attempts). `isRetryableDuckDuckGoError` returns `false`
for `DuckDuckGoUnavailableError`, `DuckDuckGoDriftError`, `UnsupportedRuntimeError`
(§0), and any abort error — including Node's `name === "AbortError"` /
`code === "ABORT_ERR"` — and `true` otherwise. Backoff before attempt `n`
(0-indexed) is `1000 * 2 ** n + rand(0..1000)` ms. An aborted caller throws
immediately; exhausting retries throws `DuckDuckGo request failed`.

### 7.9 Request serialization

All DDG work is serialized through `state.requestQueue`:

1. The new tail resolves only after both the previous tail and this attempt's
   gate resolve, so an aborted waiter cannot free the slot early.
2. Await the previous tail (interruptible), then `throwIfAborted`.
3. If `unavailableUntil > now`, throw `createCircuitOpenError`
   (`DuckDuckGo is temporarily unavailable; retry in about <n>s`).
4. Wait out `max(0, nextRequestAt - now)`, interruptibly.
5. Run the operation.
6. **Only on success**, set
   `nextRequestAt = now + 3000 + rand(0..1000)`. Deterministic failures apply no
   penalty.
7. Release the queue in `finally`.

### 7.10 Caching and dedup

- **Cache key** = `JSON.stringify({ query, allowedDomains, blockedDomains })`
  with both domain arrays **sorted**, so the same filters in any order share one
  entry. It deliberately **excludes `numResults`**: DuckDuckGo Lite returns a
  fixed page that the caller slices, so one fetch serves every count.
- The cache stores the **raw `WebSearchResult[]`**, not formatted output; the
  TTL is 10 minutes and the cap is 64 entries (expired entries are purged on
  write; the oldest insertion is evicted over the cap).
- **In-flight dedup:** concurrent identical searches share one flight. The
  shared work starts **with no signal** so the first caller's abort cannot
  reject co-waiters; each waiter applies its own signal while awaiting. The
  shared promise writes the cache once on success, and the in-flight entry is
  removed only when that shared promise settles — not when an individual waiter
  aborts — so an aborting creator cannot let a duplicate fetch start.
- `searchDuckDuckGo` slices the cached/fetched set to `params.numResults` and
  formats it per call.

### 7.11 Error mapping

`searchDuckDuckGoForTool` rethrows aborts and `UnsupportedRuntimeError` (§0)
unchanged; otherwise:

- `spawn obscura ENOENT` / `ENOENT.*obscura` / `obscura.*not found` →
  `obscura not found on PATH (required for web_search_ddg); install obscura or use web_search_exa instead. (<detail>)`.
- Otherwise →
  `DuckDuckGo web search is unavailable (<detail>). Use web_search_exa if it has not already failed; do not retry DuckDuckGo immediately.`

---

## 8. Output and truncation

### 8.1 `formatNumberedResults(provider, results)`

Zero results → `No web search results found (provider: <provider>).`
Otherwise a header `Web search results (provider: <provider>):` followed by
blocks joined with `\n\n`:

```text
1. <title>
   URL: <url>
   <snippet>
```

The snippet line is omitted when empty. The provider label is `Exa` or
`DuckDuckGo`.

### 8.2 Truncation

Apply the Pi host `truncateHead` with `maxBytes = 51200` and `maxLines = 2000`
(whole lines only, first limit hit). Exactly 2000 lines is not truncated; 2001
is. When truncated, append
`\n\n[Search output truncated by pi; reduce numResults or narrow the domain filters.]`.

### 8.3 Tool result shape

```ts
{
  content: [{ type: "text", text: truncateSearchOutput(result.text) }],
  details: { provider: "<provider>", resultCount: result.resultCount }
}
```

`details.provider` is lowercase (`exa` / `duckduckgo`), unlike the display
casing in `formatNumberedResults`. `details.resultCount` is the
**provider-reported** count before truncation: when the text is truncated,
`content[0].text` contains fewer result blocks and ends with the truncation
notice, while `resultCount` still reports how many the provider returned.

---

## 9. Constants

Machine-checked by `tests/doc-parity.test.ts`:

```json spec-constants
{
  "PACKAGE_VERSION": "2.0.0",
  "DEFAULT_NUM_RESULTS": 8,
  "MAX_NUM_RESULTS": 20,
  "MIN_QUERY_LENGTH": 2,
  "REQUEST_TIMEOUT_MS": 15000,
  "DDG_MIN_PAUSE_MS": 3000,
  "DDG_JITTER_MS": 1000,
  "DDG_CACHE_TTL_MS": 600000,
  "DDG_CACHE_MAX_ENTRIES": 64,
  "DDG_COOLDOWN_MS": 600000,
  "DDG_MAX_COOLDOWN_MS": 900000,
  "DEFAULT_MAX_BYTES": 51200,
  "DEFAULT_MAX_LINES": 2000,
  "EXA_MCP_URL": "https://mcp.exa.ai/mcp"
}
```

Literals pinned by the behavior tests rather than the parity test:

| Literal                 | Value                                       |
| ----------------------- | ------------------------------------------- |
| Exa tool names          | `web_search_exa`, `web_search_advanced_exa` |
| Exa protocol version    | `2025-03-26`                                |
| Exa `textMaxCharacters` | `1000`                                      |
| Exa client name         | `pi-web-search`                             |
| Obscura command         | `obscura`                                   |
| Obscura output cap      | `4 * 1024 * 1024` bytes                     |
| DuckDuckGo Lite URL     | `https://lite.duckduckgo.com/lite`          |
| DDG retry count / base  | `1` / `1000` ms                             |

Cooldown is clamped to `[DDG_COOLDOWN_MS, DDG_MAX_COOLDOWN_MS]`.

---

## 10. Error taxonomy

| Condition              | Type / message                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| Query too short        | `Search query must be at least 2 characters long`                                          |
| Bad `numResults`       | `numResults must be an integer between 1 and 20`                                           |
| Blank / invalid domain | `Invalid domain: <value>`                                                                  |
| Exa non-2xx            | `Exa MCP returned HTTP <status>[: <body ≤ 300>]`                                           |
| Exa JSON-RPC error     | `Exa MCP error (<code>): <message>`                                                        |
| Exa tool error         | tool text or `Exa MCP search failed`                                                       |
| Exa no result          | `Exa MCP returned no tool result`                                                          |
| Exa 401/403            | `Exa web search is unavailable (<detail>). Set EXA_API_KEY …`                              |
| Exa quota/rate limit   | `Exa quota or rate limit was reached (<detail>). Call web_search_ddg …`                    |
| Exa other              | `Exa web search is unavailable (<detail>). Call web_search_ddg …`                          |
| Obscura missing        | `obscura not found on PATH (required for web_search_ddg); …`                               |
| DDG generic            | `DuckDuckGo web search is unavailable (<detail>). …`                                       |
| DDG challenge          | `DuckDuckGoUnavailableError(reason, retryAt)`                                              |
| DDG drift              | `DuckDuckGoDriftError`: `DuckDuckGo returned results but none could be parsed; …`          |
| Circuit open           | `DuckDuckGoUnavailableError`: `DuckDuckGo is temporarily unavailable; retry in about <n>s` |
| Obscura empty output   | `Obscura returned empty DuckDuckGo HTML` (retryable)                                       |
| Node too old           | `pi-web-search requires Node >=22.19.0 (AbortSignal.timeout/any is unavailable)`           |

All `<detail>` values are whitespace-collapsed and truncated to 300 characters.

---

## 11. Fixtures and tests

`tests/behavior/*.test.ts` runs the committed fixtures against the
implementation; `npm test` runs everything.

| Path                                           | Pins                                     |
| ---------------------------------------------- | ---------------------------------------- |
| `tests/fixtures/exa/sse-multiframe.txt`        | §6.5 last-JSON-frame selection           |
| `tests/fixtures/exa/json-with-data-colon.json` | §6.4 the `data:`-substring invariant     |
| `tests/fixtures/exa/structured-results.json`   | §6.6 title/snippet precedence            |
| `tests/fixtures/exa/plain-text.txt`            | §6.6 unstructured path, `resultCount: 0` |
| `tests/fixtures/ddg/lite-results.html`         | §7.3 parsing of links + snippets         |
| `tests/fixtures/ddg/entities.html`             | §7.5 entity decoding                     |
| `tests/fixtures/ddg/selflink.html`             | §7.4 no DDG self-links                   |
| `tests/fixtures/ddg/challenge.html`            | §7.6 challenge classification            |
| `tests/fixtures/ddg/drift.html`                | §7.6 drift classification                |
| `tests/fixtures/ddg/empty.html`                | §7.6 empty classification                |

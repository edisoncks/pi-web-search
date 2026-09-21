# pi-web-search — Behavioral Specification

|                           |                                                      |
| ------------------------- | ---------------------------------------------------- |
| **Specification version** | the package version (see the constants block in §8)  |
| **Status**                | Normative for the shipped implementation             |
| **Audience**              | Contributors maintaining, extending, or reviewing it |

This document defines **what `pi-web-search` does** — the observable contract:
tool definitions, wire requests, parsing rules, output bytes, limits, and error
strings. Internal structure and the reasons behind it live in
[ARCHITECTURE.md](./ARCHITECTURE.md), and the executable truth is the `tests/`
suite. The keywords **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used as
in RFC 2119.

> **External contracts drift.** The Exa MCP endpoint, the Obscura CLI, and the
> DuckDuckGo Lite markup are third-party surfaces. The committed fixtures and
> the behavior tests are the executable truth; if they disagree with this prose,
> the fixtures win and this document is wrong.

---

## 0. Runtime requirements

- **Node `>=22.19.0`** (`engines.node`, required by the Pi host peer
  dependency). `getSearchSignal` additionally guards for
  `AbortSignal.timeout`/`AbortSignal.any` and throws `UnsupportedRuntimeError`
  with the message
  `pi-web-search requires Node >=22.19.0 (AbortSignal.timeout/any is unavailable)`.
  This is an environment fault, not a provider fault: both provider wrappers
  rethrow it unchanged (§5.6, §6.9) rather than framing it as an outage.
- `EXA_API_KEY` is optional (§5.3); `obscura` on `PATH` is required only for the
  DuckDuckGo provider (§6.1).

---

## 1. Overview

The extension registers exactly two LLM-callable tools:

1. **`web_search_exa`** — primary provider, JSON-RPC/MCP over HTTPS. No
   external binary.
2. **`web_search_ddg`** — fallback, scraping DuckDuckGo Lite through the
   external `obscura` CLI.

Provider policy (**Exa first, DuckDuckGo only on failure or explicit request**)
is enforced through the system prompt, not code: it lives in the tool
`description`, `promptSnippet`, and `promptGuidelines` strings (§3). Both tools
share one `DuckDuckGoState` instance, created once at extension load.

---

## 2. Public API

The package's **only** public API is the default export of `index.ts`, the
extension factory `(pi: ExtensionAPI) => void`. There are no named exports;
`tests/api-surface.test.ts` fails if one is added. Everything else is internal
and imported directly by tests.

---

## 3. Tool definitions

Every string below is normative, and is the only place the Exa-first policy is
expressed, so changing it changes what the model does.

### 3.1 `web_search_exa`

| Field              | Value                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | `web_search_exa`                                                                                                                                                                                                                                                                                  |
| `label`            | `Web Search (Exa)`                                                                                                                                                                                                                                                                                |
| `description`      | `Primary web search provider. Use web_search_exa first for current information and relevant sources. If Exa reports a quota, rate-limit, or provider error, call web_search_ddg instead; do not retry Exa immediately.`                                                                           |
| `promptSnippet`    | `Search the web with Exa as the primary provider`                                                                                                                                                                                                                                                 |
| `promptGuidelines` | `["Use web_search_exa first when the user needs current information or web sources.", "If web_search_exa reports an error, call web_search_ddg instead of retrying Exa immediately.", "Do not call web_search_exa and web_search_ddg for the same query unless the user requests a comparison."]` |
| `parameters`       | §3.3                                                                                                                                                                                                                                                                                              |
| `execute`          | normalize params (§4) → `searchExaForTool` (§5) → `formatSearchToolResult("exa", result)` (§7)                                                                                                                                                                                                    |

### 3.2 `web_search_ddg`

| Field              | Value                                                                                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | `web_search_ddg`                                                                                                                                                                                                                               |
| `label`            | `Web Search (DuckDuckGo)`                                                                                                                                                                                                                      |
| `description`      | `Fallback web search provider using DuckDuckGo Lite through Obscura. Only use web_search_ddg when web_search_exa reports an error or when the user explicitly requests DuckDuckGo. Do not use it for routine searches while Exa is available.` |
| `promptSnippet`    | `Search the web with DuckDuckGo only after Exa fails`                                                                                                                                                                                          |
| `promptGuidelines` | `["Use web_search_ddg only after web_search_exa reports an error or when the user explicitly requests DuckDuckGo.", "Do not use web_search_ddg as the first provider for routine searches."]`                                                  |
| `parameters`       | §3.3                                                                                                                                                                                                                                           |
| `execute`          | normalize params (§4) → `searchDuckDuckGoForTool(params, state, signal)` (§6) → `formatSearchToolResult("duckduckgo", result)` (§7)                                                                                                            |

### 3.3 Parameter schema (both tools)

| Field             | Type     | Constraints                 | Default  |
| ----------------- | -------- | --------------------------- | -------- |
| `query`           | string   | `minLength: 2`              | required |
| `allowed_domains` | string[] | each item `minLength: 1`    | absent   |
| `blocked_domains` | string[] | each item `minLength: 1`    | absent   |
| `numResults`      | integer  | `minimum: 1`, `maximum: 20` | `8`      |

Schema descriptions (shown to the LLM): `query` → `Search query, at least two
characters long`; `allowed_domains` → `Only return results from these domains`;
`blocked_domains` → `Exclude results from these domains`; `numResults` →
`Maximum number of results to return (default: 8)`.

---

## 4. Parameters and domains

Given raw `WebSearchParams`:

- `query` is trimmed. A trimmed length below 2 throws
  `Search query must be at least 2 characters long`.
- `numResults` defaults to `8`. A non-integer, `< 1`, or `> 20` throws
  `numResults must be an integer between 1 and 20`.
- Domain entries are normalized: trimmed, parsed as a URL (prefixing `https://`
  when there is no `://`), lowercased, with one trailing `.` stripped.
  `Example.COM ` → `example.com`; `example.com/foo` → `example.com`. A blank or
  structurally invalid entry MUST throw `Invalid domain: <value>` — a
  whitespace-only entry must never silently disable filtering. The result is
  deduplicated in first-seen order.
- Matching is strict: a URL matches a domain iff
  `hostname === domain || hostname.endsWith("." + domain)`. `evil-example.com`
  does not match `example.com`; an unparseable URL matches nothing.

**Filter authority:** Exa with filters present uses the server-side advanced
tool and additionally filters structured results client-side. DuckDuckGo
filters client-side only; its `site:` query operators are hints. Unstructured
Exa text reports `resultCount: 0` rather than guessing (§5.5).

---

## 5. Exa provider

### 5.1 Endpoint and tool selection

- Base URL `https://mcp.exa.ai/mcp`, overridable with the
  `PI_WEB_SEARCH_EXA_MCP_URL` environment variable (an `http(s)` URL without
  embedded credentials; an invalid value fails loudly rather than falling back).
  Only point the override at a trusted host: `EXA_API_KEY`, when set, is sent
  there.
- The request URL carries `?tools=`: `web_search_advanced_exa` when
  `allowedDomains` or `blockedDomains` is non-empty, else `web_search_exa`.

### 5.2 Wire requests

The MCP handshake runs once per session and is reused by later searches; the
session id is cached per endpoint URL, so the primary and advanced tools have
separate sessions. Establishing a session is two POSTs:

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

   `clientInfo.version` is `PACKAGE_VERSION` (§8) — never a literal. When the
   manifest is missing or unreadable, `PACKAGE_VERSION` falls back to
   `0.0.0-unknown` instead of failing the extension import.

2. **`notifications/initialized`** — no `id`, sent with the session id from step
   1: `{ "jsonrpc": "2.0", "method": "notifications/initialized" }`. A JSON-RPC
   error in its response aborts the handshake and the session id is **not**
   cached, so the next search starts a fresh handshake instead of trusting a
   half-finished one.

A search is then one `tools/call` (`id: 2`) whose `params.name` is the selected
tool and whose `params.arguments` contains `query` and `numResults`. For the
advanced tool it also contains `includeDomains` (only when `allowedDomains` is
non-empty), `excludeDomains` (only when `blockedDomains` is non-empty), and
`textMaxCharacters: 1000`.

A call that reused a **cached** session and fails with **HTTP 404** — the status
the MCP transport spec mandates for an unknown or expired `Mcp-Session-Id` —
discards the session, re-handshakes once, and retries the call once. No other
failure is retried: a freshly established session, an aborted caller, a JSON-RPC
error, or any non-404 HTTP status fails immediately. A server that returns no
session id is re-initialized on every search.

### 5.3 Request headers and deadline

| Header                 | Value                                                  |
| ---------------------- | ------------------------------------------------------ |
| `Accept`               | `application/json, text/event-stream`                  |
| `Content-Type`         | `application/json`                                     |
| `x-exa-source`         | `pi-web-search`                                        |
| `x-api-key`            | `process.env.EXA_API_KEY?.trim()`, only when non-empty |
| `Mcp-Session-Id`       | session id, only when known                            |
| `MCP-Protocol-Version` | `2025-03-26`, only when a session id is sent           |

The whole search — handshake, call, and any 404-driven re-handshake and retry —
is bounded by **one** combined signal: the caller's signal plus a single 15 s
timeout (`REQUEST_TIMEOUT_MS`). The timeout does not reset per round trip. The
response's `mcp-session-id` header, when present, becomes the session id for
later requests. `EXA_API_KEY` is **warn-and-try**: anonymous use is attempted,
and only an actual HTTP 401/403 produces a key hint (§5.6).

### 5.4 Response parsing

- Empty body → `{}` (the 202 notification response).
- SSE is detected from a `text/event-stream` content-type **or** a line that
  begins with `event:`/`data:`. A JSON body that merely _contains_ `data:` (for
  example, a result about the `data:` URL scheme) MUST stay on the JSON path.
- Parse as SSE when detected, else as JSON; on failure, fall back once to the
  other and throw
  `Exa MCP response parsed neither as JSON (…) nor as SSE fallback` (or the
  SSE-first equivalent). For SSE, the **last** JSON `data:` frame wins, and if
  none parse, `Exa MCP returned an invalid SSE response` is thrown.
- A parsed payload that is not a record (an array is not a record) throws
  `Exa MCP returned an invalid JSON-RPC response`.

### 5.5 Result shaping

1. `isError` → throw the tool text, or `Exa MCP search failed` when empty.
2. Extract text from `content[]` entries whose `type` is `"text"` or absent,
   non-empty, joined by `\n\n`, trimmed; else
   `JSON.stringify(structuredContent)`; else `""`.
3. When the text parses as a record with a `results` array, each item with a
   non-empty string `url` yields `{ title, url, snippet }`: `title` is the
   whitespace-collapsed `item.title` or `url`; `snippet` is the first available
   of `item.summary`, joined non-empty `highlights`, `item.text`, else `""`,
   whitespace-collapsed.
4. Structured results are filtered by `blockedDomains` and, when non-empty, by
   `allowedDomains`, truncated to `numResults`, and returned as
   `formatNumberedResults("Exa", filtered)` with `resultCount = filtered.length`.
5. Otherwise the raw text is returned under a `Web search results (provider:
Exa):` header (or the empty-results line) with `resultCount: 0`. The count is
   never guessed from body content.

### 5.6 Error mapping

`searchExaForTool` rewrites failures unless the caller's signal aborted or the
failure is `UnsupportedRuntimeError` (§0). The resulting messages are listed in
§9. HTTP 401/403 additionally appends the `EXA_API_KEY` hint, and
quota/rate-limit is detected by matching `quota`, `rate limit`, `too many
requests`, `HTTP 429`, or `usage limit` (case-insensitive). The bare word
`exceeded` is deliberately not a trigger, so an unrelated "response size
exceeded" is a generic failure. `<detail>` is whitespace-collapsed and
truncated to 300 characters; aborts are never rewritten.

---

## 6. DuckDuckGo provider

### 6.1 Transport

- Target `https://lite.duckduckgo.com/lite`, fetched by spawning:

  ```sh
  obscura --stealth fetch <lite-url-with-q> --dump html --quiet --wait 0 --timeout 15
  ```

- `execFile` uses `encoding: "utf8"`, `maxBuffer: 4 * 1024 * 1024`, and the
  combined request signal (§6.7). Obscura's own `--timeout` is an internal
  backstop; the combined signal is the authoritative per-search deadline. No
  separate `execFile` `timeout` is set, so no third timer races the child.
  Empty/whitespace stdout throws `Obscura returned empty DuckDuckGo HTML`
  (retryable).

### 6.2 Query construction

Parts joined by single spaces, then URL-encoded into `q`: the raw `query`; when
`allowedDomains` is non-empty, `(site:a.com OR site:b.com)`; one
`-site:<domain>` per `blockedDomains` entry. These operators are hints;
authoritative filtering is §4.

### 6.3 Parsing and URL resolution

Find anchors whose `class` contains `result-link`; resolve each `href`; drop
unusable and duplicate URLs. The section from an anchor's end to the next
matching anchor supplies the first `result-snippet` cell. Apply domain
filtering, then emit `{ title, url, snippet }` (§6.4).

URL resolution decodes entities and parses against `https://duckduckgo.com`.
With `uddg`, it rejects non-`http(s)` targets and
`duckduckgo.com`/`*.duckduckgo.com`. Without `uddg`, it rejects DDG-hosted and
non-`http(s)` links, so DuckDuckGo self-links are never surfaced. Host matching
is strict: `notduckduckgo.com` is preserved. Any failure yields no result.

### 6.4 Entity decoding and stripping

`decodeHtmlEntities` handles hex `&#xHH;`, decimal `&#DDD;`, and the named set
`amp, apos, gt, lt, nbsp, quot` (case-insensitive); unknown entities are left
untouched. `stripHtml` removes `<script>`/`<style>` contents, turns `<br>` into
a space, replaces remaining tags with a space, decodes entities, then collapses
whitespace and trims.

### 6.5 Classification

Decided on the **unfiltered** extraction, in order:

1. At least one extracted result → `{ kind: "results", results }`, with filters
   applied to the emitted set. Filtering every result away is an empty success,
   never `drift`.
2. `detectDuckDuckGoChallenge(html)` matches
   `/challenge-form|Unfortunately, bots use DuckDuckGo/i` →
   `{ kind: "challenge", reason: "DuckDuckGo returned an anti-bot challenge page" }`.
3. HTML contains a result-shaped redirect — `uddg=` whose target is an
   `http(s)` URL, i.e. `/uddg=(?:https?%3A%2F%2F|https?:\/\/)/i` →
   `{ kind: "drift" }`. A `uddg=` link to a non-web target is not drift.
4. Else `{ kind: "empty" }`.

The challenge detector is only consulted when zero results were extracted, so
snippet text cannot trip the breaker. Its markers are structural
(`challenge-form` or the page's distinctive sentence), not bare words, so an
empty page that echoes `captcha`/`anomaly` from the query stays `empty`; the
cost is that a challenge page carrying neither marker is read as `empty` and
cached for the TTL. Drift detection is a **heuristic** on the served markup: a
page that carries a web-target `uddg=` link outside its result rows can still
be misreported as drift, but a bare non-web navigation link no longer is.

### 6.6 Failure and retry semantics

- **Challenge** → `markDuckDuckGoUnavailable` (10–15 min, clamped) and throw a
  `DuckDuckGoUnavailableError(reason, retryAt)` whose message is
  `<reason>; use web_search_exa for this search.`.
- **Drift** → throw `DuckDuckGoDriftError` with
  `DuckDuckGo returned results but none could be parsed; its markup likely changed. Use web_search_exa for this search.`
  Retrying would only reproduce it: no retry, no cooldown, no spacing penalty.
- **Empty** → success with zero results.
- At most one retry (two attempts). `isRetryableDuckDuckGoError` is `false` for
  `DuckDuckGoUnavailableError`, `DuckDuckGoDriftError`,
  `UnsupportedRuntimeError` (§0), and any abort error — including Node's
  `name === "AbortError"` / `code === "ABORT_ERR"` — and `true` otherwise.
  Backoff before attempt `n` (0-indexed) is `1000 * 2 ** n + rand(0..1000)` ms.
  An aborted caller throws immediately; exhausting retries throws
  `DuckDuckGo request failed`.

### 6.7 Request serialization and deadline

All DuckDuckGo requests are serialized: a waiter that aborts while queued does
not release the slot early, so the next request cannot overlap the in-flight
one. Before running, each attempt rejects with
`DuckDuckGoUnavailableError`: `DuckDuckGo is temporarily unavailable; retry in about <n>s`
when the circuit breaker is open (`unavailableUntil > now`), then waits out
`nextRequestAt` interruptibly. **Only a completed attempt** advances
`nextRequestAt` by 3000 + rand(0..1000) ms; deterministic failures apply no
penalty. A search's combined caller-signal + 15 s timeout (§6.1) is created once
per shared fetch and shared by every retry attempt and the backoff between them.

### 6.8 Cache and dedup

- The cache key is `JSON.stringify({ query, allowedDomains, blockedDomains })`
  with both domain arrays **sorted**, so the same filters in any order share one
  entry. It deliberately **excludes `numResults`**: DuckDuckGo Lite returns a
  fixed page that the caller slices, so one fetch serves every count.
- The cache stores the raw `WebSearchResult[]` with a 10 minute TTL and a
  64-entry cap; expired entries are purged on write and the oldest insertion is
  evicted over the cap.
- Concurrent identical searches share one fetch. That shared work is not tied
  to any caller's signal, so an aborting caller neither cancels it nor rejects
  co-waiters; each waiter applies its own signal while awaiting. The cache is
  written once when the shared fetch succeeds.

### 6.9 Error mapping

`searchDuckDuckGoForTool` rethrows aborts, `UnsupportedRuntimeError` (§0), and
the typed `DuckDuckGoDriftError`/`DuckDuckGoUnavailableError` unchanged; only
unknown failures are mapped. The messages are listed in §9; `spawn obscura
ENOENT`, `ENOENT.*obscura`, or `obscura.*not found` selects the PATH hint.

---

## 7. Output and truncation

### 7.1 `formatNumberedResults(provider, results)`

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

### 7.2 Truncation

Apply the Pi host `truncateHead` with `maxBytes = 51200` and `maxLines = 2000`
(whole lines only, first limit hit). Exactly 2000 lines is not truncated; 2001
is. When truncated, append
`\n\n[Search output truncated by pi; reduce numResults or narrow the domain filters.]`.

### 7.3 Tool result shape

```ts
{
  content: [{ type: "text", text: truncateSearchOutput(result.text) }],
  details: { provider: "<provider>", resultCount: result.resultCount }
}
```

`details.provider` is lowercase (`exa` / `duckduckgo`), unlike the display
casing in `formatNumberedResults`. `details.resultCount` is the count produced
before Pi-host truncation — after provider-side domain filtering and
`numResults` slicing for Exa. When the text is truncated, `content[0].text`
contains fewer result blocks and ends with the truncation notice, while
`resultCount` still reports the pre-truncation count.

---

## 8. Constants

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
  "EXA_MCP_URL": "https://mcp.exa.ai/mcp",
  "EXA_MCP_URL_ENV": "PI_WEB_SEARCH_EXA_MCP_URL"
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

## 9. Error taxonomy

| Condition              | Type / message                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Query too short        | `Search query must be at least 2 characters long`                                                                                                                |
| Bad `numResults`       | `numResults must be an integer between 1 and 20`                                                                                                                 |
| Blank / invalid domain | `Invalid domain: <value>`                                                                                                                                        |
| Exa non-2xx            | `Exa MCP returned HTTP <status>[: <body ≤ 300>]`                                                                                                                 |
| Exa JSON-RPC error     | `Exa MCP error (<code>): <message>`                                                                                                                              |
| Exa tool error         | tool text or `Exa MCP search failed`                                                                                                                             |
| Exa no result          | `Exa MCP returned no tool result`                                                                                                                                |
| Exa 401/403            | `Exa web search is unavailable (<detail>). Set EXA_API_KEY to use Exa, or call web_search_ddg for this search instead; do not retry web_search_exa immediately.` |
| Exa quota/rate limit   | `Exa quota or rate limit was reached (<detail>). Call web_search_ddg for this search instead; do not retry web_search_exa immediately.`                          |
| Exa other              | `Exa web search is unavailable (<detail>). Call web_search_ddg for this search instead; do not retry web_search_exa immediately.`                                |
| Invalid Exa endpoint   | `PI_WEB_SEARCH_EXA_MCP_URL must be an http(s) URL without credentials: <value>`                                                                                  |
| Obscura missing        | `obscura not found on PATH (required for web_search_ddg); install obscura or use web_search_exa instead. (<detail>)`                                             |
| DDG generic            | `DuckDuckGo web search is unavailable (<detail>). Use web_search_exa if it has not already failed; do not retry DuckDuckGo immediately.`                         |
| DDG challenge          | `DuckDuckGoUnavailableError`: `DuckDuckGo returned an anti-bot challenge page; use web_search_exa for this search.`                                              |
| DDG drift              | `DuckDuckGoDriftError`: `DuckDuckGo returned results but none could be parsed; its markup likely changed. Use web_search_exa for this search.`                   |
| Circuit open           | `DuckDuckGoUnavailableError`: `DuckDuckGo is temporarily unavailable; retry in about <n>s`                                                                       |
| Obscura empty output   | `Obscura returned empty DuckDuckGo HTML` (retryable)                                                                                                             |
| Node too old           | `pi-web-search requires Node >=22.19.0 (AbortSignal.timeout/any is unavailable)`                                                                                 |

All `<detail>` values are whitespace-collapsed and truncated to 300 characters.
A rejected endpoint override redacts any embedded credentials in its `<value>`.

---

## 10. Fixtures and tests

`tests/behavior/*.test.ts` runs the committed fixtures against the
implementation; `npm test` runs everything. `tests/integration/*.test.ts` drives
the Exa MCP transport over a real socket (including the cached-session 404
re-handshake) and the DuckDuckGo subprocess path through a stub `obscura` on
`PATH`; the DuckDuckGo case is skipped on Windows.

| Path                                           | Pins                                            |
| ---------------------------------------------- | ----------------------------------------------- |
| `tests/fixtures/exa/sse-multiframe.txt`        | §5.4 last-JSON-frame selection                  |
| `tests/fixtures/exa/json-with-data-colon.json` | §5.4 the `data:`-substring invariant            |
| `tests/fixtures/exa/structured-results.json`   | §5.5 title/snippet precedence                   |
| `tests/fixtures/exa/plain-text.txt`            | §5.5 unstructured path, `resultCount: 0`        |
| `tests/fixtures/ddg/lite-results.html`         | §6.3 parsing of links + snippets                |
| `tests/fixtures/ddg/entities.html`             | §6.4 entity decoding                            |
| `tests/fixtures/ddg/selflink.html`             | §6.3 no DDG self-links                          |
| `tests/fixtures/ddg/challenge.html`            | §6.5 challenge classification                   |
| `tests/fixtures/ddg/drift.html`                | §6.5 drift classification                       |
| `tests/fixtures/ddg/no-results-nav.html`       | §6.5 a non-web `uddg=` link is empty, not drift |
| `tests/fixtures/ddg/empty-query-echo.html`     | §6.5 echoed challenge words are empty           |
| `tests/fixtures/ddg/empty.html`                | §6.5 empty classification                       |

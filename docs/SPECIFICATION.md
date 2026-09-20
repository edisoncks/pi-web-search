# pi-web-search — Behavioral Specification

|                           |                                                                 |
| ------------------------- | --------------------------------------------------------------- |
| **Specification version** | 1.0.0 (matches package `pi-web-search@1.0.0`)                   |
| **Status**                | Normative for the shipped implementation                        |
| **Audience**              | Contributors maintaining, extending, or reviewing the extension |

This document defines **what `pi-web-search` does**, in enough detail that an
independent implementation can reproduce its observable behavior. It describes
output bytes, network requests, error messages, timing/limits, and state
transitions. It does **not** prescribe internal code structure — that lives in
[ARCHITECTURE.md](./ARCHITECTURE.md).

The keywords **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are to be
interpreted as described in RFC 2119.

> **External contracts drift.** The Exa MCP endpoint, the Obscura CLI, and the
> DuckDuckGo Lite markup are third-party surfaces. Sections describing them are
> written _as implemented at v1.0.0_. The committed fixtures and the behavior
> tests (see §12) are the executable truth; if they disagree with
> this prose, the fixtures win and this document is wrong.

---

## 0. Runtime requirements

- **Node `>=22.19.0`.** The Pi host peer dependency
  `@earendil-works/pi-coding-agent` requires it (it uses `fs.globSync`). The
  extension's own `getRequestSignal` guard only checks for
  `AbortSignal.timeout`/`AbortSignal.any` (Node 20.3+); that is a lower bound,
  **not** the effective floor.
- `EXA_API_KEY` is optional (warn-and-try; §6.3).
- `obscura` on `PATH` is required only for the DuckDuckGo provider (§7.1).

---

## 1. Overview

The extension registers exactly two LLM-callable tools:

1. **`web_search_exa`** — the primary provider, speaking JSON-RPC/MCP to Exa
   over HTTPS. No external binary required.
2. **`web_search_ddg`** — the fallback provider, scraping DuckDuckGo Lite via
   the external `obscura` CLI. Requires `obscura` on `PATH`.

The provider policy (**Exa first, DuckDuckGo only on failure or explicit user
request**) is enforced through the system prompt, not through code. It lives in
the tool `description`, `promptSnippet`, and `promptGuidelines` strings (§3),
which MUST be reproduced verbatim for behavioral parity.

Both tools accept the same parameters and return the same result shape (§8).

---

## 2. Public surface

The package entry point (`index.ts`) exports the default extension factory plus
the following named symbols. Types are erased at runtime; they are still part of
the contract because importers and tests reference them.

### Types

| Symbol                     | Shape                                                                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebSearchResult`          | `{ title: string; url: string; snippet: string }`                                                                                                                                  |
| `WebSearchParams`          | `{ query: string; allowed_domains?: string[]; blocked_domains?: string[]; numResults?: number }`                                                                                   |
| `NormalizedSearchParams`   | `{ query: string; allowedDomains: string[]; blockedDomains: string[]; numResults: number }`                                                                                        |
| `ProviderSearchResult`     | `{ text: string; resultCount: number }`                                                                                                                                            |
| `DuckDuckGoCacheEntry`     | `{ result: ProviderSearchResult; expiresAt: number }`                                                                                                                              |
| `DuckDuckGoState`          | `{ requestQueue: Promise<void>; nextRequestAt: number; unavailableUntil: number; cache: Map<string, DuckDuckGoCacheEntry>; inFlight: Map<string, Promise<ProviderSearchResult>> }` |
| `McpRpcResponse`           | `{ result?: McpToolResult; error?: { code?: number; message?: string; data?: unknown } }`                                                                                          |
| `McpToolResult`            | `{ content?: Array<{ type?: string; text?: string }>; isError?: boolean; structuredContent?: unknown }`                                                                            |
| `ExaStructuredResult`      | `{ title: string; url: string; snippet: string }`                                                                                                                                  |
| `DuckDuckGoClassification` | `{ kind: "results"; results: WebSearchResult[] } \| { kind: "challenge"; reason: string } \| { kind: "drift" } \| { kind: "empty" }`                                               |

### Functions and classes

| Group                              | Symbols                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entry point                        | `default` (extension factory: `(pi: ExtensionAPI) => void`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Domain matching (`filter`)         | `normalizeDomain`, `normalizeDomains`, `hostnameOf`, `isDomainMatch`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Shared policy (`policy`)           | `getRequestSignal`, `errorMessage`, `shortErrorMessage`, `throwIfAborted`, `waitWithSignal`, `waitForPromiseWithSignal`, `randomJitter`, `clampCooldown`, `markDuckDuckGoUnavailable`, `createCircuitOpenError`, `withDuckDuckGoRequestSlot`, `isRetryableDuckDuckGoError`, `getDuckDuckGoCacheKey`, `getCachedDuckDuckGoResult`, `cacheDuckDuckGoResult`, `formatNumberedResults`, `truncateSearchOutput`, `formatSearchToolResult`, `createDuckDuckGoState`, `DuckDuckGoUnavailableError`, `DuckDuckGoDriftError`, `DDG_JITTER_MS` |
| Exa provider (`exa`)               | `buildExaInitializeRequest`, `buildExaSearchRequest`, `isExaQuotaOrRateLimitError`, `createExaSearchError`, `parseSsePayload`, `parseMcpResponse`, `postMcpRequest`, `mcpError`, `textFromMcpResult`, `parseExaStructuredResults`, `formatExaSearchResult`, `searchExa`, `searchExaForTool`                                                                                                                                                                                                                                          |
| DuckDuckGo provider (`duckduckgo`) | `buildObscuraArgs`, `decodeHtmlEntities`, `stripHtml`, `resolveDuckDuckGoResultUrl`, `parseDuckDuckGoResults`, `classifyDuckDuckGoResponse`, `detectDuckDuckGoChallenge`, `buildDuckDuckGoQuery`, `fetchDuckDuckGoAttempt`, `fetchDuckDuckGoWithRetry`, `searchDuckDuckGo`, `searchDuckDuckGoForTool`, `createDuckDuckGoSearchError`                                                                                                                                                                                                 |

> Several implementation constants (e.g. tool names, protocol version) are
> deliberately **not** exported. They are pinned by §3/§6/§7 and by the
> behavior tests.

---

## 3. Tool definitions

The extension registers the two tools below. Every string is normative.

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

The two tools share one `DuckDuckGoState` instance, created once at extension
load.

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

Before any provider is called, raw tool arguments are normalized. Given raw
`WebSearchParams`:

1. `query = raw.query.trim()`.
   - If `query.length < 2`, throw
     `Search query must be at least 2 characters long`.
2. `numResults = raw.numResults ?? 8`.
   - If `numResults` is not an integer, or `< 1`, or `> 20`, throw
     `numResults must be an integer between 1 and 20`.
3. `allowedDomains = normalizeDomains(raw.allowed_domains)` (§5).
4. `blockedDomains = normalizeDomains(raw.blocked_domains)` (§5).

The result is a `NormalizedSearchParams` with all four fields populated.

---

## 5. Domain handling

### 5.1 `normalizeDomain(domain)`

1. `value = domain.trim()`.
2. If `value` is empty, return `""` (callers reject blanks earlier; see below).
3. Parse `value` as a URL, prefixing `https://` when it contains no `://`.
4. Take `hostname`, lowercase it, and strip a single trailing `.`.
5. If the resulting hostname is empty, throw `Invalid domain: <domain>`.
6. On any parse failure, throw `Invalid domain: <domain>`.

Examples: `Example.COM` (with surrounding whitespace) → `example.com`;
`example.com/foo` → `example.com`; `https://example.com./` → `example.com`.

### 5.2 `normalizeDomains(domains)`

1. `input = domains ?? []`.
2. For every raw entry, if `raw.trim().length === 0`, throw
   `Invalid domain: <raw>`. This is the **silent-unfiltered guard**: a blank
   entry MUST NOT quietly disable filtering.
3. Return the deduplicated list of `normalizeDomain(raw)` results, preserving
   first-seen order, with any `""` results filtered out.
4. `undefined` and `[]` both yield `[]`.

### 5.3 `hostnameOf(url)`

Tolerant parsing used only for matching:

1. Strip a leading `//` (protocol-relative form).
2. Parse as a URL, prefixing `https://` when there is no `://`.
3. Lowercase the hostname and strip a single trailing `.`.
4. Return the hostname, or `undefined` on any failure or empty result.

### 5.4 `isDomainMatch(url, domains)`

1. `hostname = hostnameOf(url)`; if falsy, return `false`.
2. Return `true` iff some `domain` in `domains` satisfies
   `hostname === domain || hostname.endsWith("." + domain)`.
3. Matching is **strict** — no substring or suffix-without-dot matching.
   `evil-example.com` does **not** match `example.com`.
4. An empty `domains` list returns `false`.

**Filter authority:**

- For Exa with domain filters present, the server-side advanced tool is
  authoritative; structured results are _additionally_ filtered client-side
  with `isDomainMatch` (§6.6).
- For DuckDuckGo, filtering is client-side only. Query-embedded `site:`
  operators (§7.2) are a hint, never the authority.
- Unstructured Exa text reports `resultCount: 0` rather than guessing (§6.6).

---

## 6. Exa provider

### 6.1 Endpoint and tool selection

- Base URL: `https://mcp.exa.ai/mcp` (`EXA_MCP_URL`).
- The request URL carries a `tools` query parameter:
  - `web_search_advanced_exa` when `allowedDomains.length > 0` **or**
    `blockedDomains.length > 0`;
  - otherwise `web_search_exa`.

### 6.2 JSON-RPC handshake

Three POSTs, in order, all to the same endpoint URL:

1. **`initialize`** — body from `buildExaInitializeRequest()`:

   ```json
   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "initialize",
     "params": {
       "protocolVersion": "2025-03-26",
       "capabilities": {},
       "clientInfo": { "name": "pi-web-search", "version": "1.0.0" }
     }
   }
   ```

2. **`notifications/initialized`** — no `id`, sent with the session id from
   step 1: `{ "jsonrpc": "2.0", "method": "notifications/initialized" }`.
3. **`tools/call`** — body from `buildExaSearchRequest(params, toolName)`:

   ```json
   {
     "jsonrpc": "2.0",
     "id": 2,
     "method": "tools/call",
     "params": { "name": "<toolName>", "arguments": { ... } }
   }
   ```

   `arguments` always contains `query` and `numResults`. When `toolName` is
   `web_search_advanced_exa`, it additionally contains:

   - `includeDomains` — only when `allowedDomains.length > 0`;
   - `excludeDomains` — only when `blockedDomains.length > 0`;
   - `textMaxCharacters` — always, value `1000`.

### 6.3 Request headers

`postMcpRequest` (`postMcpRequest`) sends:

| Header                 | Value                                                  |
| ---------------------- | ------------------------------------------------------ |
| `Accept`               | `application/json, text/event-stream`                  |
| `Content-Type`         | `application/json`                                     |
| `x-exa-source`         | `pi-web-search`                                        |
| `x-api-key`            | `process.env.EXA_API_KEY?.trim()`, only when non-empty |
| `Mcp-Session-Id`       | session id, only when known                            |
| `MCP-Protocol-Version` | `2025-03-26`, only when a session id is sent           |

The request `signal` is the caller's signal combined with a 15 s timeout
(§9, `getRequestSignal`). The response's `mcp-session-id` header, when present,
becomes the session id for subsequent requests (falling back to the previous
value). `EXA_API_KEY` is **warn-and-try**: anonymous use is attempted without a
key, and only an actual HTTP 401/403 produces a key hint (§6.7).

### 6.4 Response parsing (`parseMcpResponse`)

Signature: `parseMcpResponse(body, contentType = null)`.

Given raw body text and an optional `content-type`:

1. If `body.trim()` is empty, return `{}` (the 202 `notifications/initialized`
   response).
2. Compute `looksSSE`:
   - `content-type` matches `/text\/event-stream/i`, **or**
   - the trimmed body matches `/^(event|data):/m`.
3. If **not** `looksSSE`: parse as JSON; on failure, fall back once to SSE; if
   that also fails, throw
   `Exa MCP response parsed neither as JSON (as JSON: <detail>) nor as SSE fallback`.
4. If `looksSSE`: parse as SSE; on failure, fall back once to JSON; if that also
   fails, throw
   `Exa MCP response parsed neither as SSE (as SSE: <detail>) nor as JSON fallback`.
5. If the parsed payload is not a record, throw
   `Exa MCP returned an invalid JSON-RPC response`.

**Critical invariant:** a JSON body that merely _contains_ the substring
`data:` (for example a search result about the URL scheme `data:`) MUST be
routed to the JSON parser, not the SSE parser. The `looksSSE` check keys on the
content-type and on `data:`/`event:` at the **start of a line**, not on an
anywhere-occurrence.

### 6.5 SSE parsing (`parseSsePayload`)

1. Split the body into blocks on `\r?\n\r?\n`.
2. For each block, collect lines beginning with `data:`, strip the prefix and one
   optional leading space, join with `\n`, and trim. Empty results are dropped.
3. Iterate the collected candidates **from last to first** and `JSON.parse` each;
   the first successful parse is the payload. (The final JSON-RPC frame is the
   tool result.)
4. If none parse, throw `Exa MCP returned an invalid SSE response`.

### 6.6 Result shaping (`formatExaSearchResult`)

Given the `McpToolResult` and normalized params:

1. If `result.isError` is true, throw `textFromMcpResult(result)` or
   `Exa MCP search failed` when that is empty.
2. `rawText = textFromMcpResult(result)`:
   - concatenate `content[]` entries whose `type` is `"text"` or absent, keeping
     non-empty `text` values, joined by `\n\n`, trimmed;
   - if empty and `structuredContent !== undefined`, use
     `JSON.stringify(structuredContent)`;
   - otherwise `""`.
3. `structuredResults = parseExaStructuredResults(rawText)`:
   - `JSON.parse` the text; on failure return `undefined`;
   - require a record whose `results` is an array, else `undefined`;
   - for each record item with a non-empty string `url`, emit
     `{ title, url, snippet }` where:
     - `title = item.title` if a non-empty string, else `url`;
     - `snippet` is the first available of `item.summary`, the `highlights`
       array joined with `" "` (only when non-empty), `item.text`, else `""`,
       with all whitespace collapsed to single spaces and trimmed.
4. If `structuredResults` is defined:
   - drop results matching `blockedDomains`;
   - keep results when `allowedDomains` is empty or the result matches
     `allowedDomains`;
   - truncate to `numResults`;
   - return `{ text: formatNumberedResults("Exa", filtered), resultCount: filtered.length }`.
5. Otherwise (unstructured text): return
   - text `Web search results (provider: Exa):\n\n<rawText>` when `rawText` is
     non-empty, else `No web search results found (provider: Exa).`;
   - `resultCount: 0` — **never** guessed from body content (a line beginning
     `Title:` must not inflate the count).

### 6.7 Error mapping

- Non-2xx HTTP from `postMcpRequest` throws
  `Exa MCP returned HTTP <status>` plus `: <first 300 chars>` when the body is
  non-empty.
- A JSON-RPC `error` field throws via `mcpError`:
  `Exa MCP error (<code>): <message>` (`<code>` omitted when absent; message
  defaults to `unknown error`).
- A missing `result` after a successful call throws
  `Exa MCP returned no tool result`.
- `searchExaForTool` wraps any failure: if the caller's signal is aborted it
  rethrows unchanged; otherwise it throws `createExaSearchError(error)`:
  - When the detail matches `/http\s*40[13]/i`, throw
    `Exa web search is unavailable (<detail>). Set EXA_API_KEY to use Exa, or call web_search_ddg for this search instead; do not retry web_search_exa immediately.`
  - Otherwise, when the detail matches
    `/quota|rate.?limit|too many requests|http\s*429|usage limit|exceeded/i`,
    the reason is `Exa quota or rate limit was reached`; else it is
    `Exa web search is unavailable`. The thrown message is
    `<reason> (<detail>). Call web_search_ddg for this search instead; do not retry web_search_exa immediately.`
  - `<detail>` is `shortErrorMessage(error)` (whitespace-collapsed, ≤ 300 chars).
- Aborts are **never** rewritten into provider errors.

---

## 7. DuckDuckGo provider

### 7.1 Transport

- Target URL: `https://lite.duckduckgo.com/lite`.
- Fetched by spawning the `obscura` binary with the argv produced by
  `buildObscuraArgs(params)`:

  ```sh
  obscura --stealth fetch <lite-url-with-q> --dump html --quiet --wait 0 --timeout <seconds>
  ```

  where `<seconds> = ceil(15000 / 1000) = 15`.

- `execFile` options: `encoding: "utf8"`, `maxBuffer: 4 * 1024 * 1024`
  (4194304 bytes), `timeout: 15000`, and the combined request signal.
- Empty/whitespace stdout throws `Obscura returned empty DuckDuckGo HTML`.

### 7.2 Query construction (`buildDuckDuckGoQuery`)

Given normalized params, the query string is composed of, in order:

1. the raw `query`;
2. when `allowedDomains` is non-empty, a parenthesized group
   `(site:a.com OR site:b.com)` (domains joined by `OR`, each prefixed
   `site:`);
3. one `-site:<domain>` term per `blockedDomains` entry.

Parts are joined by single spaces, then URL-encoded into the `q` parameter.
These `site:` operators are hints only; authoritative filtering is §5.4.

### 7.3 HTML parsing (`parseDuckDuckGoResults`)

Signature: `parseDuckDuckGoResults(html, allowedDomains = [], blockedDomains = [])`.

1. Normalize `allowedDomains`/`blockedDomains` (§5.2).
2. Find every anchor matching
   `<a ... class="...result-link..." ...>…</a>` (class token matched within the
   attribute value).
3. For each anchor, extract `href` and resolve it via
   `resolveDuckDuckGoResultUrl` (§7.4). Drop anchors without a usable URL and
   drop duplicate URLs seen earlier on the page.
4. The "section" for an anchor runs from the end of the anchor to the start of
   the next matching anchor (or end of document). Within it, the first
   `<td ... class="...result-snippet..." ...>…</td>` supplies the snippet.
5. Apply filtering: drop when `isDomainMatch(url, blockedDomains)`; drop when
   `allowedDomains` is non-empty and `!isDomainMatch(url, allowedDomains)`.
6. Emit `{ title: stripHtml(anchorText), url, snippet }`, snippet `""` when
   absent.

`stripHtml` (§7.5) is applied to both title and snippet.

### 7.4 URL resolution (`resolveDuckDuckGoResultUrl`)

1. Decode HTML entities in `href`, then parse against base
   `https://duckduckgo.com`.
2. If there is a `uddg` query parameter, parse its value as a URL;
   - reject it when it is not `http:`/`https:`, or when its hostname ends with
     `duckduckgo.com`;
   - otherwise return its string form.
3. If there is **no** `uddg`:
   - reject when the link's hostname ends with `duckduckgo.com`
     (keep internal navigation out of results);
   - reject when the protocol is not `http:`/`https:`;
   - otherwise return the link's string form.
4. Any parse failure returns `undefined`.

### 7.5 HTML entity decoding and stripping

- `decodeHtmlEntities` handles, in order: hex `&#xHH;`, decimal `&#DDD;`, and
  the named set `amp, apos, gt, lt, nbsp, quot` (case-insensitive). Unknown
  entities are left untouched.
- `stripHtml` removes `<script>`/`<style>` element contents, converts `<br>`
  to a space, replaces every remaining tag with a space, decodes entities, then
  collapses all whitespace and trims.

### 7.6 Classification (`classifyDuckDuckGoResponse`)

Signature: `classifyDuckDuckGoResponse(html, allowedDomains = [], blockedDomains = [])`.
Classification is decided by the **unfiltered** extraction (§7.3); the domain
filters are applied only to the results that are emitted.

Evaluated in this exact order:

1. If unfiltered extraction yields ≥ 1 result → `{ kind: "results", results }`,
   where `results` is that set with the domain filters applied (§7.3). Filtering
   every result away is a successful empty result set; it MUST NOT be reported
   as `drift`.
2. Else if `detectDuckDuckGoChallenge(html)` matches →
   `{ kind: "challenge", reason }`.
3. Else if the HTML contains `uddg=` → `{ kind: "drift" }`.
4. Else → `{ kind: "empty" }`.

`detectDuckDuckGoChallenge` matches the structural markers
`/challenge-form|anomaly|captcha|Unfortunately, bots use DuckDuckGo/i` and
returns the fixed reason
`DuckDuckGo returned an anti-bot challenge page`. It MUST only be consulted
when zero results parsed, so that snippet text (e.g. a search _about_ "HTTP
429") cannot trip the breaker.

### 7.7 Failure semantics

- **Challenge** → mark the circuit unavailable (`markDuckDuckGoUnavailable`,
  10–15 min, §9) and throw a `DuckDuckGoUnavailableError` whose `retryAt` is the
  cooldown deadline.
- **Drift** (HTML contained `uddg=` but nothing parsed: DuckDuckGo changed
  markup) → throw a `DuckDuckGoDriftError` with the message
  `DuckDuckGo returned results but none could be parsed; its markup likely changed. Use web_search_exa for this search.`
  Drift is **deterministic**: fail fast, no retry, no cooldown, no spacing
  penalty.
- **Empty result set** (neither results nor drift) → success with zero results;
  the formatted text is `No web search results found (provider: DuckDuckGo).`

### 7.8 Retry policy (`fetchDuckDuckGoWithRetry`)

- At most `DDG_MAX_RETRIES = 1` retry (2 attempts total).
- `isRetryableDuckDuckGoError` returns `false` for
  `DuckDuckGoUnavailableError`, `DuckDuckGoDriftError`, and `AbortError`; it
  returns `true` for all other errors (transient I/O).
- The backoff before attempt `n` (0-indexed) is
  `DDG_RETRY_BASE_MS * 2 ** n + randomJitter(DDG_JITTER_MS)` =
  `1000 * 2**n + rand(0..1000)` ms.
- If the caller's signal aborts, throw immediately.
- Exhausting retries throws `DuckDuckGo request failed`.

### 7.9 Request serialization (`withDuckDuckGoRequestSlot`)

All DDG work is serialized through a promise queue (`state.requestQueue`):

1. Chain onto the previous queue tail and take ownership of the new tail.
2. Await the previous tail (interruptible by the caller's signal), then
   `throwIfAborted`.
3. If `state.unavailableUntil > Date.now()`, throw `createCircuitOpenError`
   (`DuckDuckGo is temporarily unavailable; retry in about <n>s`, with
   `n = max(1, ceil((retryAt - now)/1000))`).
4. Wait out the spacing `max(0, state.nextRequestAt - Date.now())` (interruptible).
5. Run the operation.
6. **Only on success**, set
   `state.nextRequestAt = Date.now() + 3000 + randomJitter(1000)`. Deterministic
   failures (drift/challenge/abort) apply no spacing penalty.
7. Release the queue in `finally`, always.

### 7.10 Caching and dedup (`searchDuckDuckGo`)

- Cache key: `JSON.stringify({ query, allowedDomains, blockedDomains, numResults })`.
- TTL: 10 minutes (`DDG_CACHE_TTL_MS`). Max entries: 64
  (`DDG_CACHE_MAX_ENTRIES`).
- On a cache hit (non-expired) return the cached `ProviderSearchResult`.
- On write: purge all expired entries, delete any existing key, insert the new
  entry, then evict from the front (oldest insertion) while size > 64.
- **In-flight dedup:** concurrent identical searches share one flight. The
  shared work is started **with no signal**, so the first caller's abort cannot
  reject co-waiters; each waiter (including the creator) applies only its own
  signal while awaiting the shared promise. A successful shared result is cached
  once. The in-flight entry is removed in `finally` when it is still the current
  one.

### 7.11 Error mapping (`createDuckDuckGoSearchError`)

`searchDuckDuckGoForTool` rethrows aborts unchanged; otherwise it maps:

- When the detail matches `/spawn obscura ENOENT|ENOENT.*obscura|obscura.*not found/i`,
  throw
  `obscura not found on PATH (required for web_search_ddg); install obscura or use web_search_exa instead. (<detail>)`.
- Otherwise throw
  `DuckDuckGo web search is unavailable (<detail>). Use web_search_exa if it has not already failed; do not retry DuckDuckGo immediately.`

`<detail>` is `shortErrorMessage(error)`.

---

## 8. Output and truncation

### 8.1 `formatNumberedResults(provider, results)`

- Zero results → `No web search results found (provider: <provider>).`
- Otherwise, a header `Web search results (provider: <provider>):` followed by
  one block per result, blocks joined by `\n\n`:

  ```text
  1. <title>
     URL: <url>
     <snippet>
  ```

  The snippet line is omitted when `snippet` is empty. The `provider` label is
  `Exa` or `DuckDuckGo` (display casing).

### 8.2 Truncation (`truncateSearchOutput`)

- Apply `truncateHead` with `maxBytes = 50 * 1024 (51200)` and
  `maxLines = 2000` (the Pi host defaults).
- `truncateHead` keeps whole lines only and stops at whichever limit is hit
  first. Exactly 2000 lines is **not** truncated; 2001 lines is.
- If the first line alone exceeds the byte limit, the retained content is empty
  and the notice is still appended.
- When not truncated, return the content unchanged.
- When truncated, append
  `\n\n[Search output truncated by pi; reduce numResults or narrow the domain filters.]`.

### 8.3 Tool result shape (`formatSearchToolResult`)

```ts
{
  content: [{ type: "text", text: truncateSearchOutput(result.text) }],
  details: { provider: "<provider>", resultCount: result.resultCount }
}
```

`details.provider` is lowercase `exa` or `duckduckgo` — note this differs from
the display casing in `formatNumberedResults`.

---

## 9. Constants

Machine-checked by `tests/doc-parity.test.ts`:

```json spec-constants
{
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

Additional literals pinned by the behavior tests rather than the parity test
(they are not exported from the entry point):

| Literal                 | Value                                       |
| ----------------------- | ------------------------------------------- |
| Exa tool names          | `web_search_exa`, `web_search_advanced_exa` |
| Exa protocol version    | `2025-03-26`                                |
| Exa `textMaxCharacters` | `1000`                                      |
| Exa client identity     | `pi-web-search` / `1.0.0`                   |
| Obscura command         | `obscura`                                   |
| Obscura output cap      | `4 * 1024 * 1024` bytes                     |
| DuckDuckGo Lite URL     | `https://lite.duckduckgo.com/lite`          |
| DDG retry count / base  | `1` / `1000` ms                             |

Cooldown is clamped to `[DDG_COOLDOWN_MS, DDG_MAX_COOLDOWN_MS]`
(`clampCooldown`).

---

## 10. Error taxonomy

| Condition              | Type / message                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| Query too short        | `Error`: `Search query must be at least 2 characters long`                                 |
| Bad `numResults`       | `Error`: `numResults must be an integer between 1 and 20`                                  |
| Blank / invalid domain | `Error`: `Invalid domain: <value>`                                                         |
| Exa non-2xx            | `Error`: `Exa MCP returned HTTP <status>[: <body ≤ 300>]`                                  |
| Exa JSON-RPC error     | `Error`: `Exa MCP error (<code>): <message>`                                               |
| Exa tool error         | `Error`: tool text or `Exa MCP search failed`                                              |
| Exa no result          | `Error`: `Exa MCP returned no tool result`                                                 |
| Exa 401/403            | `Error`: `Exa web search is unavailable (<detail>). Set EXA_API_KEY …`                     |
| Exa quota/rate limit   | `Error`: `Exa quota or rate limit was reached (<detail>). Call web_search_ddg …`           |
| Exa other              | `Error`: `Exa web search is unavailable (<detail>). Call web_search_ddg …`                 |
| Obscura missing        | `Error`: `obscura not found on PATH (required for web_search_ddg); …`                      |
| DDG generic            | `Error`: `DuckDuckGo web search is unavailable (<detail>). …`                              |
| DDG challenge          | `DuckDuckGoUnavailableError(reason, retryAt)`                                              |
| DDG drift              | `DuckDuckGoDriftError`: `DuckDuckGo returned results but none could be parsed; …`          |
| Circuit open           | `DuckDuckGoUnavailableError`: `DuckDuckGo is temporarily unavailable; retry in about <n>s` |
| Obscura empty output   | `Error`: `Obscura returned empty DuckDuckGo HTML` (retryable)                              |
| Node too old           | `Error`: `pi-web-search requires Node >=20.3 (AbortSignal.timeout/any missing)`            |

All `<detail>` values are whitespace-collapsed and truncated to 300 characters.

The Node guard message references 20.3 because that is the lower bound for
`AbortSignal.timeout`/`any`; the effective runtime floor is Node `>=22.19.0`
(§0).

---

## 11. Test-label legend

Tests and fixtures reference `P1`–`P7`, inherited from the original review
findings. They map to behaviors as follows:

| Label | Behavior                                                                                |
| ----- | --------------------------------------------------------------------------------------- |
| `P1`  | Content-type-aware MCP parsing (a JSON body containing `data:` is not misrouted to SSE) |
| `P2`  | Abort isolation for shared in-flight work                                               |
| `P3`  | Strict rejection of blank domain entries                                                |
| `P4`  | Typed retry policy and success-only spacing penalty                                     |
| `P5`  | Tolerant URL parsing, strict domain matching                                            |
| `P6`  | Never surface DuckDuckGo self-links as results                                          |
| `P7`  | Actionable errors (auth hint, Obscura PATH hint, honest `resultCount`)                  |

---

## 12. Fixtures and tests

The behaviors above are pinned by these artifacts. `tests/behavior/*.test.ts`
runs them against the implementation using the committed fixtures, and
`npm test` runs the whole set.

| Path                                           | Pins                                     |
| ---------------------------------------------- | ---------------------------------------- |
| `tests/fixtures/exa/sse-multiframe.txt`        | §6.5 last-JSON-frame selection           |
| `tests/fixtures/exa/json-with-data-colon.json` | §6.4 the `data:`-substring invariant     |
| `tests/fixtures/exa/structured-results.json`   | §6.6 title/snippet precedence            |
| `tests/fixtures/exa/plain-text.txt`            | §6.6 unstructured path, `resultCount: 0` |
| `tests/fixtures/ddg/lite-results.html`         | §7.3 parsing of links + snippets         |
| `tests/fixtures/ddg/entities.html`             | §7.5 entity decoding                     |
| `tests/fixtures/ddg/selflink.html`             | §7.4 / `P6` no DDG self-links            |
| `tests/fixtures/ddg/challenge.html`            | §7.6 challenge classification            |
| `tests/fixtures/ddg/drift.html`                | §7.6 drift classification                |
| `tests/fixtures/ddg/empty.html`                | §7.6 empty classification                |

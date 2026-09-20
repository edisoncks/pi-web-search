# Architecture

Non-normative. This document explains **how the implementation is organized
and why**. The observable contract is [SPECIFICATION.md](./SPECIFICATION.md);
if the two conflict, the SPEC wins.

## Module roles

| Module | Responsibility | Depends on |
|---|---|---|
| `lib/types.ts` | Scalar constants, interfaces, the `isRecord` guard. No imports. | — |
| `lib/filter.ts` | Pure domain normalization and matching. | `types` |
| `lib/policy.ts` | Cross-cutting state and policy: rate limiting, cache, circuit breaker, request serialization, dedup, signals, formatting. | `types`, Pi host |
| `lib/exa.ts` | Exa MCP transport (JSON-RPC over `fetch`) and result shaping. | `types`, `filter`, `policy` |
| `lib/duckduckgo.ts` | Obscura fetch and DuckDuckGo Lite HTML parsing. | `types`, `filter`, `policy` |
| `index.ts` | Parameter normalization, tool schemas, `pi.registerTool` wiring, and the public re-export surface. | all of the above |

## Dependency graph

```
index ──▶ { exa, duckduckgo, policy, filter, types }
exa ──▶ { filter, types, policy }
duckduckgo ──▶ { filter, types, policy }
policy ──▶ { types }
filter ──▶ { types }
types ──▶ ∅
```

The graph is acyclic. `types` is the sink so every module may depend on it;
`filter` and `policy` are leaves below the providers; nothing below `index`
imports `index`.

## Data flow

### Exa (primary)

```
tool call
├─ normalizeSearchParams  (index.ts)
│  └─ searchExaForTool  (exa.ts)
│     └─ searchExa
│        ├─ buildExaInitializeRequest  →  POST initialize
│        ├─ POST notifications/initialized  (session id; mcp-session-id echoed forward)
│        ├─ buildExaSearchRequest  →  POST tools/call
│        ├─ parseMcpResponse  (JSON/SSE aware)
│        └─ formatExaSearchResult
│           ├─ parseExaStructuredResults
│           └─ isDomainMatch filtering
└─ formatSearchToolResult  (policy.ts)
```

### DuckDuckGo (fallback)

```
tool call
├─ normalizeSearchParams  (index.ts)
│  └─ searchDuckDuckGoForTool  (duckduckgo.ts)
│     └─ searchDuckDuckGo
│        ├─ cache hit? return cached result
│        ├─ in-flight hit? await the shared promise
│        └─ fetchDuckDuckGoWithRetry
│           └─ withDuckDuckGoRequestSlot  (serialize + spacing + breaker)
│              └─ fetchDuckDuckGoAttempt
│                 ├─ buildObscuraArgs  →  execFile("obscura", …)
│                 └─ classifyDuckDuckGoResponse
│                    └─ parseDuckDuckGoResults
└─ formatSearchToolResult  (policy.ts)
```

## Design rationale

These are the decisions most likely to trip up a contributor changing this
code, and why the implementation made them.

- **Signal-less shared work.** Concurrent identical DDG searches share one
  flight started *without* any caller's signal. If the shared work were tied to
  the first caller, that caller's abort would reject every co-waiter. Each
  waiter applies its own signal only while awaiting the shared promise
  (`waitForPromiseWithSignal`), so abort isolation is per-caller.

- **Success-only spacing penalty.** `withDuckDuckGoRequestSlot` advances
  `nextRequestAt` only after a completed attempt. Deterministic failures
  (drift/challenge/abort) fail fast with no penalty; cooldowns for rate-limit
  cases are owned by the circuit breaker. Charging a penalty on deterministic
  failure would just delay the next real request for no reason.

- **Drift is deterministic.** If DDG changed markup, an identical retry fails
  identically. So drift throws a typed `DuckDuckGoDriftError` with no retry and
  no cooldown, and tells the caller to use Exa. Challenge pages, by contrast,
  are transient and trip the 10–15 minute breaker.

- **Warn-and-try auth.** `EXA_API_KEY` is optional. Anonymous Exa use is
  attempted; only an actual HTTP 401/403 produces the key hint. This avoids
  nagging users who don't need a key.

- **Honest `resultCount`.** Unstructured Exa text reports `resultCount: 0`
  rather than guessing from body content. A heuristic like "count lines
  starting with `Title:`" would inflate the count on any result that happens to
  contain that text.

- **`policy` owns state, providers own transport.** `DuckDuckGoState` lives in
  `policy` so both the provider and the extension share one breaker/cache/queue
  without the transport modules owning cross-cutting concerns.

## Patterns and invariants

These are easy to break accidentally. The behavior tests pin most of them, but
know them before you touch the relevant code.

- **Parse SSE from the content-type, or from a line-leading `event:`/`data:`** —
  never from an anywhere-occurrence of `data:`. A JSON body whose *content*
  mentions `data:` must stay on the JSON path (`P1`).
- **The last SSE `data:` frame wins.** The JSON-RPC result is the final frame.
- **Shared in-flight DDG work carries no caller's signal.** Apply each caller's
  signal only while it awaits the shared promise (`P2`).
- **Spacing advances only on success.** `nextRequestAt` is updated after a
  completed attempt, never on a deterministic failure (`P4`).
- **Blank domain entries throw.** A whitespace-only entry must not silently
  disable filtering (`P3`).
- **Domain matching is strict:** `hostname === domain || hostname.endsWith("." + domain)`.
  No bare-suffix matching (`P5`).
- **Never surface DuckDuckGo self-links.** Drop `duckduckgo.com` links and links
  without a usable `uddg` target (`P6`).
- **Drift and challenge are different.** `uddg=` present with zero parsed
  results is *drift* (deterministic, no cooldown); challenge markers are
  transient and trip the breaker. Only consult the challenge detector when zero
  results parsed.
- **`resultCount` is honest.** Unstructured Exa text reports `0`, never a guess
  (`P7`).
- **Provider casing differs by surface.** `details.provider` is lowercase
  (`exa` / `duckduckgo`); `formatNumberedResults` uses display casing (`Exa` /
  `DuckDuckGo`).
- **The prompt strings are behavior.** The Exa-first/fallback policy lives in
  the tool `description`/`promptSnippet`/`promptGuidelines` (SPEC §3); changing
  them changes what the model does.

## Packaging

- `package.json` declares the extension via the `pi` manifest
  (`"extensions": ["./index.ts"]`) and the `pi-package` keyword.
- `@earendil-works/pi-coding-agent` and `typebox` are `peerDependencies` with
  `"*"`, marked optional; Pi bundles them.
- `engines.node` is `>=22.19.0`, matching the Pi host peer dependency
  `@earendil-works/pi-coding-agent`. The `getRequestSignal` guard checks only
  for `AbortSignal.timeout`/`any` (Node 20.3+), a lower bound that is **not** the
  effective floor.
- The `files` allowlist ships `index.ts`, `lib`, `docs`, `README.md`, and
  `LICENSE`.

## Documentation contract

Documentation and tests are part of the code, and CI enforces it:

- `tests/doc-parity.test.ts` fails if a value in the SPEC's constants block
  disagrees with the code.
- `tests/doc-coverage.test.ts` fails if an exported symbol is not named in the
  SPEC.
- `tests/doc-links.test.ts` fails on a broken relative link between docs.
- `tests/behavior/*.test.ts` pins the wire/parse/format behavior against the
  committed fixtures.

**When you change observable behavior, update the SPEC, the fixtures, and the
behavior tests in the same change.** If you don't, `npm run verify` will tell
you what you missed. See [CONTRIBUTING.md](../CONTRIBUTING.md).

# Recreating `pi-web-search` from the specification

This guide is for building an independent implementation that passes the
conformance suite using [SPECIFICATION.md](./SPECIFICATION.md) alone. It is the
practical companion to the normative spec: what to build, in what order, and
where reimplementations usually go wrong.

The validation loop is deliberately empirical. "The docs are sufficient" is a
claim you *test*, not one you assert.

## Prerequisites

- Node `>=20.3.0` (`AbortSignal.timeout` / `AbortSignal.any`).
- `typebox` and `@earendil-works/pi-coding-agent` as peer dependencies (Pi
  bundles them).
- `obscura` on `PATH` only if you want the DuckDuckGo path to actually fetch.
  Parsing/classification can be validated against fixtures without it.

## Suggested build order

Build bottom-up so each layer is testable before the next depends on it:

1. **`types`** — the constants and interfaces from SPEC §2/§9. No imports.
2. **`filter`** — `normalizeDomain`, `normalizeDomains`, `hostnameOf`,
   `isDomainMatch` (SPEC §5). Pure; test it in isolation. Watch the
   blank-entry rejection (`P3`) and tolerant-parse/strict-match split (`P5`).
3. **`policy`** — signals, waits, jitter, cooldown clamping, the request slot,
   cache key/read/write, `formatNumberedResults`, truncation, and
   `formatSearchToolResult` (SPEC §8, §9).
4. **`exa`** — the three pure builders, `parseSsePayload`, `parseMcpResponse`,
   structured-result parsing, formatting, error mapping, then `searchExa`
   (SPEC §6). The wire contract is in §6.2/§6.3.
5. **`duckduckgo`** — `buildDuckDuckGoQuery`, `stripHtml`/`decodeHtmlEntities`,
   `resolveDuckDuckGoResultUrl`, `parseDuckDuckGoResults`,
   `classifyDuckDuckGoResponse`, `buildObscuraArgs`, then the retry/serialization
   wrapper (SPEC §7).
6. **entry point** — parameter normalization, the two tool definitions with
   verbatim prompt strings, and the `pi.registerTool` wiring (SPEC §3, §4).

## Validation loop

Run the conformance suite against your implementation as you go:

```sh
PI_WEB_SEARCH_IMPL=/path/to/your/index.ts npm run conformance
```

The suite imports the module named by `PI_WEB_SEARCH_IMPL` (default: this
repo's entry point) and asserts the documented behaviors using committed
fixtures. A failure is a documentation bug or an implementation bug — decide
which, and fix the right one.

This repository's own dry-run (the one that validated this spec) is not
committed, precisely so it cannot rot into a second unsynced implementation.
The suite and fixtures are the durable artifact.

## Traps that bite reimplementations

Each of these is called out in the SPEC; they are repeated here because they are
where independent implementations diverge in practice.

- **`data:` substring.** A JSON response whose *content* contains `data:` must
  not be routed to the SSE parser. Detect SSE from the content-type or a
  line-leading `event:`/`data:`, never from an anywhere-occurrence (`P1`).
- **Last SSE frame wins.** Parse SSE `data:` candidates from last to first; the
  JSON-RPC result is the final frame.
- **Abort isolation.** Shared in-flight DDG work must not carry any caller's
  signal; apply each signal only on the wait (`P2`).
- **Success-only spacing.** `nextRequestAt` advances only after a completed
  attempt, never on deterministic failure (`P4`).
- **Blank domains throw.** A whitespace-only domain entry must throw, not
  silently disable filtering (`P3`).
- **Strict matching.** `hostname === domain || hostname.endsWith("." + domain)`;
  no bare-suffix matching (`P5`).
- **No DDG self-links.** Drop `duckduckgo.com` links and links without a usable
  `uddg` target (`P6`).
- **Drift vs challenge.** `uddg=` present with zero results is *drift*
  (deterministic, no cooldown); challenge markers are transient (breaker). Only
  consult the challenge detector when zero results parsed.
- **Honest count.** Unstructured Exa text reports `resultCount: 0` (`P7`).
- **Provider casing.** `details.provider` is lowercase (`exa` / `duckduckgo`);
  `formatNumberedResults` uses display casing (`Exa` / `DuckDuckGo`).
- **Prompt strings are behavior.** The Exa-first/fallback policy lives in the
  tool `description`/`promptSnippet`/`promptGuidelines`. Reproduce them
  verbatim (SPEC §3).

## Definition of done

Your implementation satisfies the specification when:

1. `PI_WEB_SEARCH_IMPL=/path/to/your/index.ts npm run conformance` passes, and
2. the entry point exports every symbol listed in SPEC §2, and
3. the constants in your implementation match the SPEC §9 block.

Export completeness is checked for this repository by
`tests/doc-coverage.test.ts`; for a new implementation, compare against the §2
table directly.

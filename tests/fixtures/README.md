# Fixtures

Payloads that pin the wire/parse/format behaviors described in
[`docs/SPECIFICATION.md`](../../docs/SPECIFICATION.md) and asserted by the
`tests/behavior/` suite.

## Provenance

All fixtures are **synthetic**. They were authored by hand to match the shapes
the implementation handles and the DuckDuckGo Lite / Exa MCP / Obscura
contracts documented in [`docs/SPECIFICATION.md`](../../docs/SPECIFICATION.md).
They are not captured production traffic and contain no private data. When the
upstream services change shape, update these fixtures (and the spec)
deliberately rather than pasting live responses.

## Layout

| Fixture                         | Pins                                                                      |
| ------------------------------- | ------------------------------------------------------------------------- |
| `exa/sse-multiframe.txt`        | Last JSON frame of an SSE stream wins                                     |
| `exa/json-with-data-colon.json` | A JSON body containing `data:` is not misrouted to SSE                    |
| `exa/structured-results.json`   | Title fallback and snippet precedence (`summary` → `highlights` → `text`) |
| `exa/plain-text.txt`            | Unstructured path reports `resultCount: 0`                                |
| `ddg/lite-results.html`         | `result-link` / `result-snippet` parsing and `uddg` resolution            |
| `ddg/entities.html`             | Entity decoding (known entities decoded, unknown left as-is)              |
| `ddg/selflink.html`             | DDG self-links and non-http targets are dropped                           |
| `ddg/challenge.html`            | Challenge classification                                                  |
| `ddg/drift.html`                | Drift classification (`uddg=` present, zero parsed results)               |
| `ddg/no-results-nav.html`       | A non-web `uddg=` nav link is empty, not drift                            |
| `ddg/empty.html`                | Empty classification                                                      |

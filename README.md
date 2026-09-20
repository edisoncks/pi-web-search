# pi-web-search

Two web-search tools for [pi](https://pi.dev):

- **`web_search_exa`** — primary provider, Exa MCP over HTTPS. No external
  binary.
- **`web_search_ddg`** — fallback, DuckDuckGo Lite through the
  [Obscura](https://github.com/h4ckf0r0day/obscura) CLI.

The policy is **Exa first; DuckDuckGo only when Exa fails or the user explicitly
asks for it.** It is encoded in the tools' system-prompt guidance, so the model
follows it automatically.

## Requirements

- **Node `>=22.19.0`** — required by the Pi host peer dependency
  `@earendil-works/pi-coding-agent` (it uses `fs.globSync`). The extension's own
  `AbortSignal.timeout`/`any` guard is a lower bound at 20.3, but the host
  governs the effective floor.
- `EXA_API_KEY` — optional. Exa is tried anonymously; a key is only needed when
  the server rejects the request.
- `obscura` on `PATH` — required **only** for `web_search_ddg`. Obscura is a
  separate dependency and is not installed by this package; install it from its
  official instructions.

## Install

```bash
pi install git:github.com/edisoncks/pi-web-search@v1.0.0
```

## Documentation

- [SPECIFICATION.md](./docs/SPECIFICATION.md) — the normative behavioral
  contract: tool definitions, wire protocols, parsers, limits, and error
  taxonomy. Sufficient to reimplement the extension.
- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — module roles, dependency graph,
  data flow, and design rationale.
- [RECREATION.md](./docs/RECREATION.md) — step-by-step reimplementation guide and
  validation loop.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — the documentation contract and how to
  run the checks.

## Development

```bash
npm install
npm run verify      # typecheck + unit/doc tests + conformance
```

Individual commands:

```bash
npm run typecheck
npm test             # units + SPEC parity/coverage/link checks
npm run conformance  # behavior suite against the entry point
```

The conformance suite can validate any implementation of the documented surface:

```bash
PI_WEB_SEARCH_IMPL=/path/to/other/index.ts npm run conformance
```

## License

MIT — see [LICENSE](./LICENSE).

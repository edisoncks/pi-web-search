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
  `@earendil-works/pi-coding-agent` (it uses `fs.globSync`).
- `EXA_API_KEY` — optional. Exa is tried anonymously; a key is only needed when
  the server rejects the request.
- `obscura` on `PATH` — required **only** for `web_search_ddg`. Obscura is a
  separate dependency and is not installed by this package; install it from its
  official instructions.

## Install

```bash
pi install git:github.com/edisoncks/pi-web-search
```

This tracks the repository's default branch, so Pi's update check notifies you
when it moves and `pi update --extensions` applies the update. To pin a specific
release instead — which Pi's update check skips — append a tag:

```bash
pi install git:github.com/edisoncks/pi-web-search@v2.0.0
```

## Documentation

- [SPECIFICATION.md](./docs/SPECIFICATION.md) — the behavioral contract: tool
  definitions, parameter handling, wire protocols, parsers, limits, and error
  taxonomy.
- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — module roles, dependency graph,
  data flow, and the invariants to preserve when changing the code.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — how to run the checks and the
  documentation contract.

## Development

```bash
npm install
npm run verify      # typecheck + all tests
```

Individual commands:

```bash
npm run typecheck
npm test            # units, behavior tests, and documentation gates
```

## License

MIT — see [LICENSE](./LICENSE).

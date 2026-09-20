# Contributing

## Documentation is part of the code

This repository treats the
[SPECIFICATION](./docs/SPECIFICATION.md) and the conformance suite as the
contract, not as afterthoughts. **When you change observable behavior, update
the SPEC, the fixtures, and the conformance suite in the same change.** If you
forget, `npm run verify` will tell you what you missed.

The gates:

| Check | Enforces |
|---|---|
| `tests/doc-parity.test.ts` | The SPEC constants block matches the code. |
| `tests/doc-coverage.test.ts` | Every symbol exported by `index.ts` is named in the SPEC. |
| `tests/doc-links.test.ts` | Every relative link between docs resolves. |
| `tests/conformance/*.conformance.ts` | The documented wire/parse/format behavior. |

## Running

```sh
npm install
npm run verify      # typecheck + unit/doc tests + conformance
```

Individual pieces:

```sh
npm run typecheck
npm test            # unit and documentation tests
npm run conformance # behavior suite against the entry point
```

## Validating a reimplementation

The conformance suite can judge any implementation of the documented surface:

```sh
PI_WEB_SEARCH_IMPL=/path/to/other/index.ts npm run conformance
```

See [docs/RECREATION.md](./docs/RECREATION.md) for the reimplementation guide.

## Commit style

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`,
`chore:`). Keep code changes and documentation changes reviewable: a pure
refactor should be its own commit (or PR) and must not change behavior.

## Third-party contracts

The Exa MCP endpoint, the Obscura CLI, and DuckDuckGo Lite markup are external
and can drift. When they change, update the fixtures and the SPEC deliberately —
do not paste live responses into the fixtures. Their provenance is documented in
[`tests/fixtures/README.md`](./tests/fixtures/README.md).

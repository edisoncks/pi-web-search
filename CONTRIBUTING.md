# Contributing

## Documentation is part of the code

The [SPECIFICATION](./docs/SPECIFICATION.md) and the behavior tests are the
contract, not afterthoughts. **When you change observable behavior, update the
SPEC, the fixtures, and the behavior tests in the same change.** If you forget,
`npm run verify` will tell you what you missed.

The gates:

| Check                        | Enforces                                                               |
| ---------------------------- | ---------------------------------------------------------------------- |
| `tests/doc-parity.test.ts`   | The SPEC constants block matches the code.                             |
| `tests/doc-coverage.test.ts` | Every symbol exported by `index.ts` is named in the SPEC.              |
| `tests/doc-links.test.ts`    | Every relative link between docs resolves.                             |
| `tests/behavior/*.test.ts`   | The documented wire/parse/format behavior, against committed fixtures. |

## Running

```sh
npm install
npm run verify      # typecheck + all tests
```

Individual pieces:

```sh
npm run typecheck
npm test            # units, behavior tests, and documentation gates
```

## Where things live

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — module roles, dependency
  graph, data flow, and the invariants to preserve.
- [docs/SPECIFICATION.md](./docs/SPECIFICATION.md) — the behavioral contract.
- [tests/fixtures/README.md](./tests/fixtures/README.md) — what each fixture
  pins.

## Commit style

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`,
`chore:`). Keep code changes and documentation changes reviewable: a pure
refactor should be its own commit (or PR) and must not change behavior.

## Third-party contracts

The Exa MCP endpoint, the Obscura CLI, and DuckDuckGo Lite markup are external
and can drift. When they change, update the fixtures and the SPEC deliberately —
do not paste live responses into the fixtures. Their provenance is documented in
[`tests/fixtures/README.md`](./tests/fixtures/README.md).

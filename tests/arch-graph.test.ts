import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The ARCHITECTURE dependency claims are prose next to the code, so they rot.
// This test derives the real internal edges from the imports and asserts both
// the dependency graph and the module-roles table agree. External packages are
// ignored; "Pi host" is not an internal module.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const architectureText = await readFile(
  resolve(repoRoot, "docs/ARCHITECTURE.md"),
  "utf8",
);

// Discovered from the filesystem, not hardcoded: adding a lib module without
// documenting it must fail this test instead of slipping past it.
const MODULES: readonly string[] = [
  "index",
  ...(await readdir(resolve(repoRoot, "lib")))
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => basename(entry, ".ts")),
].sort();

function sourcePath(module: string): string {
  return module === "index"
    ? resolve(repoRoot, "index.ts")
    : resolve(repoRoot, "lib", `${module}.ts`);
}

/** Internal modules imported by a source file. */
function internalDependencies(source: string): Set<string> {
  const dependencies = new Set<string>();
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/gu)) {
    const name = match[1]
      .replace(/^\.\//u, "")
      .replace(/^lib\//u, "")
      .replace(/\.js$/u, "");
    if (MODULES.includes(name) && name !== "index") {
      dependencies.add(name);
    }
  }
  return dependencies;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/** Parse the fenced dependency graph (`a ──▶ { b, c }` / `a ──▶ ∅`). */
function parseGraph(text: string): Map<string, Set<string>> {
  const block = text.match(/## Dependency graph\s+```text\n([\s\S]*?)```/u);
  assert.ok(block, "ARCHITECTURE must contain the dependency graph block");

  const graph = new Map<string, Set<string>>();
  for (const line of block[1].split("\n")) {
    const withDeps = line.match(/^(\w+)\s+──▶\s+\{(.*)\}\s*$/u);
    if (withDeps) {
      graph.set(
        withDeps[1],
        new Set(
          withDeps[2]
            .split(",")
            .map((dep) => dep.trim())
            .filter((dep) => MODULES.includes(dep)),
        ),
      );
      continue;
    }
    const empty = line.match(/^(\w+)\s+──▶\s+∅\s*$/u);
    if (empty) graph.set(empty[1], new Set());
  }
  return graph;
}

/** Parse the module-roles table's "Depends on" column. */
function parseTable(text: string): Map<string, Set<string>> {
  const table = new Map<string, Set<string>>();
  const rowPattern =
    /^\|\s*`(index\.ts|lib\/[\w-]+\.ts)`\s*\|([^|]*)\|([^|]*)\|\s*$/gmu;
  for (const row of text.matchAll(rowPattern)) {
    const module = basename(row[1], ".ts");
    const dependencies = new Set<string>();
    for (const dep of row[3].matchAll(/`([^`]+)`/gu)) {
      if (MODULES.includes(dep[1])) {
        dependencies.add(dep[1]);
      }
    }
    table.set(module, dependencies);
  }
  return table;
}

const graph = parseGraph(architectureText);
const table = parseTable(architectureText);

const actual = new Map<string, Set<string>>();
for (const module of MODULES) {
  actual.set(
    module,
    internalDependencies(await readFile(sourcePath(module), "utf8")),
  );
}

describe("ARCHITECTURE dependency claims match the imports", () => {
  it("covers every module in the graph and the table", () => {
    assert.deepEqual(sorted(graph.keys()), sorted(MODULES));
    assert.deepEqual(sorted(table.keys()), sorted(MODULES));
  });

  for (const module of MODULES) {
    it(`${module} edges match the dependency graph`, () => {
      assert.deepEqual(sorted(actual.get(module)!), sorted(graph.get(module)!));
    });

    it(`${module} edges match the module-roles table`, () => {
      assert.deepEqual(sorted(actual.get(module)!), sorted(table.get(module)!));
    });
  }
});

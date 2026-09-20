import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const indexPath = fileURLToPath(new URL("../index.ts", import.meta.url));

/** Names exported by the entry point, excluding the default factory. */
function namedExports(entry: string): string[] {
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  assert.ok(source, `could not load ${entry}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  assert.ok(moduleSymbol, `${entry} is not a module`);
  return checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) => symbol.getName())
    .filter((name) => name !== "default");
}

describe("entry-point API surface (guard against re-bloating)", () => {
  it("exports exactly the default extension factory and nothing else", () => {
    // Internals live in lib/ and tests import them directly. If you are adding
    // a named export to index.ts, put it in the relevant lib module instead —
    // unless you truly intend to widen the package's public API.
    assert.deepEqual(namedExports(indexPath), []);
  });
});

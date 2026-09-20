import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const indexPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const specText = await readFile(
  new URL("../docs/SPECIFICATION.md", import.meta.url),
  "utf8",
);

function exportedNames(entry: string): string[] {
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

describe("SPEC export coverage (no undocumented surface)", () => {
  const names = exportedNames(indexPath);
  assert.ok(names.length > 0, "expected index.ts to export symbols");

  for (const name of names) {
    it(`documents export '${name}'`, () => {
      assert.ok(
        specText.includes(name),
        `SPECIFICATION.md does not mention exported symbol '${name}'`,
      );
    });
  }
});

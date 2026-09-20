import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const indexPath = fileURLToPath(new URL("../index.ts", import.meta.url));

/**
 * Top-level `export` statements in a module source. The package's only public
 * API is the default extension factory, so exactly one `export default
 * function` line is allowed; any named export or re-export would add another
 * and fail the assertion below.
 */
function exportStatements(source: string): string[] {
  return source.match(/^export\b.*$/gmu) ?? [];
}

describe("entry-point API surface (guard against re-bloating)", () => {
  it("exports exactly the default extension factory and nothing else", () => {
    const source = readFileSync(indexPath, "utf8");
    const exports = exportStatements(source);
    assert.equal(
      exports.length,
      1,
      `index.ts must export only the default factory; found:\n${exports.join("\n")}`,
    );
    assert.match(exports[0], /^export default function\b/);
  });
});

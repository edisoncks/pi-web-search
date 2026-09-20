import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as entry from "../index.js";

// The package's only public API is the default export of index.ts, the
// extension factory. Internals live in lib/ and are imported directly by tests;
// adding a named export to index.ts widens the public API and must be a
// deliberate decision, not an accident. Importing the module and inspecting its
// namespace tests the actual export surface rather than the file's text, so a
// legitimate refactor that keeps the default export keeps this test green.
describe("entry-point API surface (guard against re-bloating)", () => {
  it("exports exactly the default extension factory and nothing else", () => {
    assert.deepEqual(Object.keys(entry), ["default"]);
    assert.equal(typeof entry.default, "function");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSearchParameters,
  normalizeSearchParams,
} from "../lib/params.js";

describe("normalizeSearchParams", () => {
  it("trims the query and applies defaults", () => {
    assert.deepEqual(normalizeSearchParams({ query: "  hello  " }), {
      query: "hello",
      allowedDomains: [],
      blockedDomains: [],
      numResults: 8,
    });
  });

  it("rejects a query shorter than the minimum after trimming", () => {
    assert.throws(
      () => normalizeSearchParams({ query: " a " }),
      /at least 2 characters/,
    );
  });

  it("rejects an out-of-range or non-integer numResults", () => {
    for (const numResults of [0, 21, 1.5, Number.NaN]) {
      assert.throws(
        () => normalizeSearchParams({ query: "ok", numResults }),
        /between 1 and 20/,
      );
    }
  });

  it("normalizes and dedupes domain filters", () => {
    assert.deepEqual(
      normalizeSearchParams({
        query: "ok",
        allowed_domains: [" Example.COM ", "example.com"],
        blocked_domains: ["b.com"],
      }),
      {
        query: "ok",
        allowedDomains: ["example.com"],
        blockedDomains: ["b.com"],
        numResults: 8,
      },
    );
  });
});

describe("createSearchParameters", () => {
  it("declares the four documented fields", () => {
    const schema = createSearchParameters() as {
      properties?: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
      "allowed_domains",
      "blocked_domains",
      "numResults",
      "query",
    ]);
  });
});

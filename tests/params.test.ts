import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createFetchParameters,
  createSearchParameters,
  normalizeFetchParams,
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

describe("normalizeFetchParams", () => {
  it("normalizes a schemeless URL to an absolute https URL", () => {
    assert.deepEqual(normalizeFetchParams({ url: " example.com/a " }), {
      url: "https://example.com/a",
    });
    assert.deepEqual(normalizeFetchParams({ url: "https://b.org" }), {
      url: "https://b.org/",
    });
  });

  it("rejects blank, non-http, and unparseable URLs", () => {
    for (const url of [
      "",
      "   ",
      "ftp://example.com",
      "https://exa mple.com",
    ]) {
      assert.throws(() => normalizeFetchParams({ url }), /Invalid URL/);
    }
  });
});

describe("createFetchParameters", () => {
  it("declares the single documented url field", () => {
    const schema = createFetchParameters() as {
      properties?: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ["url"]);
  });
});

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
  it("normalizes schemeless URLs and dedupes in first-seen order", () => {
    assert.deepEqual(
      normalizeFetchParams({
        urls: [" example.com/a ", "https://example.com/a", "https://b.org"],
      }),
      { urls: ["https://example.com/a", "https://b.org/"] },
    );
  });

  it("rejects blank, non-http, and unparseable URLs", () => {
    for (const url of [
      "",
      "   ",
      "ftp://example.com",
      "https://exa mple.com",
    ]) {
      assert.throws(() => normalizeFetchParams({ urls: [url] }), /Invalid URL/);
    }
  });

  it("requires at least one URL", () => {
    assert.throws(() => normalizeFetchParams({ urls: [] }), /At least 1 URL/);
  });

  it("caps the batch at five distinct URLs", () => {
    const five = Array.from({ length: 5 }, (_, i) => `https://e.com/${i}`);
    assert.equal(normalizeFetchParams({ urls: five }).urls.length, 5);
    assert.throws(
      () => normalizeFetchParams({ urls: [...five, "https://e.com/5"] }),
      /At most 5 URLs/,
    );
  });
});

describe("createFetchParameters", () => {
  it("declares the single documented urls field", () => {
    const schema = createFetchParameters() as {
      properties?: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ["urls"]);
  });
});

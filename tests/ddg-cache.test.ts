import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cacheDuckDuckGoResults,
  createDuckDuckGoState,
  getCachedDuckDuckGoResults,
  getDuckDuckGoCacheKey,
} from "../lib/policy.js";
import { searchDuckDuckGo } from "../lib/duckduckgo.js";

const base = { query: "q", allowedDomains: [], blockedDomains: [] };

const page = [
  { title: "One", url: "https://a.example", snippet: "s1" },
  { title: "Two", url: "https://b.example", snippet: "s2" },
  { title: "Three", url: "https://c.example", snippet: "s3" },
];

describe("DDG cache key ignores numResults (P8: one fetch per query)", () => {
  it("produces the same key for different numResults", () => {
    assert.equal(
      getDuckDuckGoCacheKey({ ...base, numResults: 5 }),
      getDuckDuckGoCacheKey({ ...base, numResults: 8 }),
    );
  });

  it("is order-insensitive for the domain filters", () => {
    assert.equal(
      getDuckDuckGoCacheKey({
        ...base,
        allowedDomains: ["a.com", "b.com"],
        blockedDomains: ["c.com", "d.com"],
        numResults: 8,
      }),
      getDuckDuckGoCacheKey({
        ...base,
        allowedDomains: ["b.com", "a.com"],
        blockedDomains: ["d.com", "c.com"],
        numResults: 8,
      }),
    );
  });

  it("stores the full result set, not a pre-sliced one", () => {
    const state = createDuckDuckGoState();
    const key = getDuckDuckGoCacheKey({ ...base, numResults: 1 });
    cacheDuckDuckGoResults(state, key, page);
    assert.deepEqual(getCachedDuckDuckGoResults(state, key), page);
  });

  it("slices a single cached page per call's numResults without refetching", async () => {
    const state = createDuckDuckGoState();
    const key = getDuckDuckGoCacheKey({ ...base, numResults: 8 });
    cacheDuckDuckGoResults(state, key, page);

    const two = await searchDuckDuckGo(
      { ...base, numResults: 2 },
      state,
      undefined,
    );
    assert.equal(two.resultCount, 2);
    assert.match(two.text, /provider: DuckDuckGo/);
    assert.doesNotMatch(two.text, /Three/);

    const three = await searchDuckDuckGo(
      { ...base, numResults: 3 },
      state,
      undefined,
    );
    assert.equal(three.resultCount, 3);
    assert.match(three.text, /Three/);
  });
});

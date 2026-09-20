import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDuckDuckGoState } from "../lib/policy.js";
import { searchDuckDuckGo } from "../lib/duckduckgo.js";

const base = { query: "q", allowedDomains: [], blockedDomains: [] };

const page = [
  { title: "One", url: "https://a.example", snippet: "s1" },
  { title: "Two", url: "https://b.example", snippet: "s2" },
  { title: "Three", url: "https://c.example", snippet: "s3" },
];

describe("DDG in-flight dedup (P2: abort does not duplicate work)", () => {
  it("keeps shared work alive when its creator aborts", async () => {
    const state = createDuckDuckGoState();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fakeFetch = async () => {
      calls += 1;
      await gate;
      return page;
    };

    const controller = new AbortController();
    const creator = searchDuckDuckGo(
      { ...base, numResults: 3 },
      state,
      controller.signal,
      fakeFetch,
    );
    controller.abort();
    await assert.rejects(creator);

    // The shared work is still running: a second caller must join it instead
    // of starting a duplicate fetch.
    const second = searchDuckDuckGo(
      { ...base, numResults: 3 },
      state,
      undefined,
      fakeFetch,
    );
    release();

    const out = await second;
    assert.equal(out.resultCount, 3);
    assert.equal(calls, 1);
  });

  it("caches the shared result once for later callers", async () => {
    const state = createDuckDuckGoState();
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return page;
    };

    const first = await searchDuckDuckGo(
      { ...base, numResults: 2 },
      state,
      undefined,
      fakeFetch,
    );
    const second = await searchDuckDuckGo(
      { ...base, numResults: 9 },
      state,
      undefined,
      fakeFetch,
    );

    assert.equal(first.resultCount, 2);
    assert.equal(second.resultCount, 3);
    assert.equal(calls, 1);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDuckDuckGoState } from "../lib/policy.js";
import {
  fetchDuckDuckGoWithRetry,
  type DuckDuckGoAttempt,
} from "../lib/duckduckgo.js";
import type { NormalizedSearchParams } from "../lib/types.js";

const params: NormalizedSearchParams = {
  query: "q",
  allowedDomains: [],
  blockedDomains: [],
  numResults: 8,
};

describe("DuckDuckGo retry shares one search deadline", () => {
  it("passes the same combined signal to every retry attempt", async () => {
    const state = createDuckDuckGoState();
    const seen: Array<AbortSignal | undefined> = [];
    let calls = 0;
    const attempt: DuckDuckGoAttempt = async (_params, _state, signal) => {
      seen.push(signal);
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return [{ title: "T", url: "https://example.com", snippet: "" }];
    };

    const results = await fetchDuckDuckGoWithRetry(
      params,
      state,
      undefined,
      attempt,
    );

    assert.equal(results.length, 1);
    assert.equal(calls, 2);
    // The deadline is created once in the retry wrapper and reused, so retries
    // cannot extend the caller-visible bound.
    assert.ok(seen[0] instanceof AbortSignal);
    assert.equal(seen[0], seen[1]);
  });
});

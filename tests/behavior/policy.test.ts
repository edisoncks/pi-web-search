import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createDuckDuckGoState,
  isRetryableDuckDuckGoError,
  withDuckDuckGoRequestSlot,
  DuckDuckGoDriftError,
  DuckDuckGoUnavailableError,
} from "../../lib/policy.js";
import { isDomainMatch, normalizeDomains } from "../../lib/filter.js";
import { createExaSearchError } from "../../lib/exa.js";
import { createDuckDuckGoSearchError } from "../../lib/duckduckgo.js";

describe("policy behavior: domains and errors", () => {
  it("rejects blank domain entries", () => {
    assert.throws(() => normalizeDomains([" "]), /Invalid domain/);
    assert.throws(() => normalizeDomains([""]), /Invalid domain/);
  });

  it("matches strictly, with tolerant parsing", () => {
    assert.equal(isDomainMatch("sub.example.com/a", ["example.com"]), true);
    assert.equal(isDomainMatch("evil-example.com", ["example.com"]), false);
  });

  it("maps Exa 401 to an EXA_API_KEY hint", () => {
    assert.match(
      createExaSearchError(new Error("Exa MCP returned HTTP 401: nope"))
        .message,
      /EXA_API_KEY/,
    );
  });

  it("maps Obscura ENOENT to a PATH hint", () => {
    assert.match(
      createDuckDuckGoSearchError(new Error("spawn obscura ENOENT")).message,
      /obscura not found on PATH/,
    );
  });
});

describe("policy behavior: retry, breaker, spacing", () => {
  it("does not retry typed deterministic failures", () => {
    const unavailable = new DuckDuckGoUnavailableError(
      "busy",
      Date.now() + 1000,
    );
    assert.equal(unavailable.name, "DuckDuckGoUnavailableError");
    assert.equal(isRetryableDuckDuckGoError(unavailable), false);
    assert.equal(
      isRetryableDuckDuckGoError(new Error("spawn obscura ETIMEDOUT")),
      true,
    );
  });

  it("advances spacing only on a successful attempt", async () => {
    const state = createDuckDuckGoState();
    const before = Date.now();
    await withDuckDuckGoRequestSlot(state, undefined, async () => "ok");
    assert.ok(state.nextRequestAt >= before + 3000);

    const state2 = createDuckDuckGoState();
    await assert.rejects(
      withDuckDuckGoRequestSlot(state2, undefined, () => {
        throw new DuckDuckGoDriftError("markup changed");
      }),
      /markup changed/,
    );
    assert.equal(state2.nextRequestAt, 0);
  });
});

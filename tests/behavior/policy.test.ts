import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createDuckDuckGoState,
  formatNumberedResults,
  formatSearchToolResult,
  isRetryableDuckDuckGoError,
  truncateSearchOutput,
  withDuckDuckGoRequestSlot,
  DuckDuckGoDriftError,
  DuckDuckGoUnavailableError,
} from "../../lib/policy.js";
import { isDomainMatch, normalizeDomains } from "../../lib/filter.js";
import { createExaSearchError } from "../../lib/exa.js";
import { createDuckDuckGoSearchError } from "../../lib/duckduckgo.js";

describe("policy behavior: formatting", () => {
  it("formats numbered results exactly", () => {
    assert.equal(
      formatNumberedResults("Exa", [
        { title: "T", url: "https://e.com", snippet: "S" },
      ]),
      "Web search results (provider: Exa):\n\n1. T\n   URL: https://e.com\n   S",
    );
  });

  it("formats the empty case", () => {
    assert.equal(
      formatNumberedResults("DuckDuckGo", []),
      "No web search results found (provider: DuckDuckGo).",
    );
  });

  it("shapes the tool result with lowercase provider", () => {
    assert.deepEqual(
      formatSearchToolResult("exa", { text: "x", resultCount: 3 }),
      {
        content: [{ type: "text", text: "x" }],
        details: { provider: "exa", resultCount: 3 },
      },
    );
  });

  it("truncates oversized output with the documented notice", () => {
    const big = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n");
    assert.match(truncateSearchOutput(big), /\[Search output truncated by pi;/);
  });

  it("does not truncate exactly 2000 lines but does at 2001", () => {
    const exact = Array.from({ length: 2000 }, (_, i) => `l${i}`).join("\n");
    assert.equal(truncateSearchOutput(exact), exact);

    const over = Array.from({ length: 2001 }, (_, i) => `l${i}`).join("\n");
    assert.match(
      truncateSearchOutput(over),
      /\[Search output truncated by pi;/,
    );
  });

  it("truncates when a single line exceeds the byte cap", () => {
    assert.match(
      truncateSearchOutput("x".repeat(60000)),
      /\[Search output truncated by pi;/,
    );
  });
});

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

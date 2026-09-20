import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatNumberedResults,
  formatSearchToolResult,
  truncateSearchOutput,
} from "../../lib/format.js";

describe("output formatting", () => {
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

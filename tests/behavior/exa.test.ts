import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as impl from "../../lib/exa.js";
import { isRecord, type McpRpcResponse } from "../../lib/types.js";
import { readFixture } from "./helpers.js";

/** The first text block of an MCP tool result, or "" when absent. */
function firstResultText(response: McpRpcResponse): string {
  const item = response.result?.content?.[0];
  assert.equal(item?.type, "text");
  return item?.text ?? "";
}

describe("Exa behavior: MCP parsing and shaping", () => {
  it("selects the last JSON frame of an SSE stream", async () => {
    const body = await readFixture("exa", "sse-multiframe.txt");
    const parsed = impl.parseSsePayload(body);
    assert.ok(isRecord(parsed));
    assert.equal(firstResultText(parsed), "LATE_FRAME");
  });

  it("does not misroute a JSON body containing 'data:' to SSE", async () => {
    const body = await readFixture("exa", "json-with-data-colon.json");
    assert.equal(
      firstResultText(impl.parseMcpResponse(body, "application/json")),
      "See the data: URL scheme and event: handlers for details",
    );
  });

  it("parses that JSON body with a null content-type too", async () => {
    const body = await readFixture("exa", "json-with-data-colon.json");
    assert.equal(
      firstResultText(impl.parseMcpResponse(body, null)),
      "See the data: URL scheme and event: handlers for details",
    );
  });

  it("returns {} for an empty body (202 notification)", () => {
    assert.deepEqual(impl.parseMcpResponse("  \n  ", "application/json"), {});
  });

  it("parses structured results with the documented precedence", async () => {
    const raw = await readFixture("exa", "structured-results.json");
    const results = impl.parseExaStructuredResults(raw);
    assert.ok(results);
    assert.equal(results.length, 4);
    assert.deepEqual(results[0], {
      title: "Alpha",
      url: "https://example.com/a",
      snippet: "Summary A",
    });
    assert.deepEqual(results[1], {
      title: "https://example.com/b",
      url: "https://example.com/b",
      snippet: "highlight B1 highlight B2",
    });
    assert.deepEqual(results[2], {
      title: "Gamma",
      url: "https://example.com/c",
      snippet: "text C",
    });
    assert.deepEqual(results[3], {
      title: "Delta",
      url: "https://example.com/d",
      snippet: "",
    });
  });

  it("reports resultCount 0 for unstructured text", async () => {
    const text = await readFixture("exa", "plain-text.txt");
    const params = {
      query: "q",
      allowedDomains: [],
      blockedDomains: [],
      numResults: 8,
    };
    const out = impl.formatExaSearchResult(
      { content: [{ type: "text", text }] },
      params,
    );
    assert.equal(out.resultCount, 0);
    assert.match(out.text, /Title: this is not a search result/);
  });

  it("collapses whitespace in structured titles", () => {
    const raw = JSON.stringify({
      results: [{ title: "  Alpha\n  Beta  ", url: "https://example.com/x" }],
    });
    const results = impl.parseExaStructuredResults(raw);
    assert.ok(results);
    assert.equal(results[0].title, "Alpha Beta");
  });

  it("falls back to the URL for a whitespace-only title", () => {
    const raw = JSON.stringify({
      results: [
        { title: "   ", url: "https://example.com/fallback", text: "s" },
      ],
    });
    const results = impl.parseExaStructuredResults(raw);
    assert.ok(results);
    assert.equal(results[0].title, "https://example.com/fallback");
  });

  it("falls through whitespace-only highlights to the text snippet", () => {
    const raw = JSON.stringify({
      results: [
        { url: "https://example.com/y", highlights: ["   "], text: "fallback" },
      ],
    });
    const results = impl.parseExaStructuredResults(raw);
    assert.ok(results);
    assert.equal(results[0].snippet, "fallback");
  });
});

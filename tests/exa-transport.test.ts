import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { postMcpRequest } from "../index.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("postMcpRequest headers", () => {
  it("sends the protocol-version header for a sessioned request", async () => {
    let captured: Record<string, string> = {};
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured = init?.headers as Record<string, string>;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await postMcpRequest(
      "https://example.test/mcp",
      { jsonrpc: "2.0" },
      "sess-1",
      undefined,
    );

    assert.equal(captured["MCP-Protocol-Version"], "2025-03-26");
    assert.equal(captured["Mcp-Session-Id"], "sess-1");
  });

  it("omits the session headers when there is no session", async () => {
    let captured: Record<string, string> = {};
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured = init?.headers as Record<string, string>;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await postMcpRequest(
      "https://example.test/mcp",
      { jsonrpc: "2.0" },
      undefined,
      undefined,
    );

    assert.equal(captured["MCP-Protocol-Version"], undefined);
    assert.equal(captured["Mcp-Session-Id"], undefined);
  });
});

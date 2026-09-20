import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as impl from "../../index.js";

const params = {
  query: "hello world",
  allowedDomains: ["a.com"],
  blockedDomains: ["b.com"],
  numResults: 5,
};

describe("wire behavior: Exa JSON-RPC bodies", () => {
  it("builds the initialize request", () => {
    assert.deepEqual(impl.buildExaInitializeRequest(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "pi-web-search", version: "1.0.0" },
      },
    });
  });

  it("builds a primary tools/call request", () => {
    assert.deepEqual(impl.buildExaSearchRequest(params, "web_search_exa"), {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: { query: "hello world", numResults: 5 },
      },
    });
  });

  it("builds an advanced tools/call request with filters and textMaxCharacters", () => {
    assert.deepEqual(
      impl.buildExaSearchRequest(params, "web_search_advanced_exa"),
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "web_search_advanced_exa",
          arguments: {
            query: "hello world",
            numResults: 5,
            includeDomains: ["a.com"],
            excludeDomains: ["b.com"],
            textMaxCharacters: 1000,
          },
        },
      },
    );
  });
});

describe("wire behavior: DuckDuckGo query and Obscura argv", () => {
  it("composes site: operators", () => {
    assert.equal(
      impl.buildDuckDuckGoQuery({
        query: "q",
        allowedDomains: ["a.com", "b.com"],
        blockedDomains: ["c.com"],
        numResults: 8,
      }),
      "q (site:a.com OR site:b.com) -site:c.com",
    );
  });

  it("builds the exact Obscura argv", () => {
    assert.deepEqual(impl.buildObscuraArgs(params), [
      "--stealth",
      "fetch",
      "https://lite.duckduckgo.com/lite?q=hello+world+%28site%3Aa.com%29+-site%3Ab.com",
      "--dump",
      "html",
      "--quiet",
      "--wait",
      "0",
      "--timeout",
      "15",
    ]);
  });
});

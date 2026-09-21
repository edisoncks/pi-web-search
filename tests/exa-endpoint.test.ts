import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXA_MCP_URL,
  EXA_MCP_URL_ENV,
  InvalidExaEndpointError,
  resolveExaMcpUrl,
  searchExaForTool,
} from "../lib/exa.js";
import type { NormalizedSearchParams } from "../lib/types.js";

describe("resolveExaMcpUrl", () => {
  it("defaults to EXA_MCP_URL when the override is unset or blank", () => {
    assert.equal(resolveExaMcpUrl({}), EXA_MCP_URL);
    assert.equal(resolveExaMcpUrl({ [EXA_MCP_URL_ENV]: "   " }), EXA_MCP_URL);
  });

  it("uses a trimmed http(s) override", () => {
    assert.equal(
      resolveExaMcpUrl({ [EXA_MCP_URL_ENV]: "  http://127.0.0.1:8080/mcp " }),
      "http://127.0.0.1:8080/mcp",
    );
  });

  it("rejects a non-http(s) override", () => {
    for (const value of ["ftp://example.com", "file:///etc/passwd"]) {
      assert.throws(
        () => resolveExaMcpUrl({ [EXA_MCP_URL_ENV]: value }),
        (error: unknown) => error instanceof InvalidExaEndpointError,
      );
    }
  });

  it("rejects embedded credentials and unparseable values", () => {
    assert.throws(
      () => resolveExaMcpUrl({ [EXA_MCP_URL_ENV]: "https://u:p@example.com" }),
      InvalidExaEndpointError,
    );
    assert.throws(
      () => resolveExaMcpUrl({ [EXA_MCP_URL_ENV]: "not a url" }),
      InvalidExaEndpointError,
    );
  });

  it("redacts credentials from a rejected override", () => {
    assert.throws(
      () =>
        resolveExaMcpUrl({
          [EXA_MCP_URL_ENV]: "https://user:s3cret@example.com",
        }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidExaEndpointError);
        assert.doesNotMatch(error.message, /s3cret/u);
        assert.match(error.message, /\/\/\*\*\*@/u);
        return true;
      },
    );
  });
});

describe("searchExaForTool surfaces a bad endpoint override unchanged", () => {
  const params: NormalizedSearchParams = {
    query: "hello",
    allowedDomains: [],
    blockedDomains: [],
    numResults: 3,
  };

  it("does not wrap a configuration fault as a provider outage", async () => {
    const previous = process.env[EXA_MCP_URL_ENV];
    process.env[EXA_MCP_URL_ENV] = "ftp://example.com";
    try {
      await assert.rejects(
        searchExaForTool(params, undefined),
        (error: unknown) => error instanceof InvalidExaEndpointError,
      );
    } finally {
      if (previous === undefined) delete process.env[EXA_MCP_URL_ENV];
      else process.env[EXA_MCP_URL_ENV] = previous;
    }
  });
});

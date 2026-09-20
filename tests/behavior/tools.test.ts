import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerWebSearchTools } from "../../lib/tools.js";
import type {
  NormalizedSearchParams,
  ProviderSearchResult,
} from "../../lib/types.js";

// The tool metadata and execute wiring in lib/tools.ts are behavior: the
// description/promptSnippet/promptGuidelines encode the Exa-first fallback
// policy, and a swapped execute body would silently invert the providers.
// Capture the registrations with a stub ExtensionAPI and assert both.

interface CapturedCall {
  provider: "exa" | "duckduckgo";
  params: NormalizedSearchParams;
  hasSignal: boolean;
}

function setup(): {
  tools: ToolDefinition[];
  calls: CapturedCall[];
} {
  const tools: ToolDefinition[] = [];
  const calls: CapturedCall[] = [];
  const pi = {
    registerTool: (tool: ToolDefinition) => {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;

  const result = (provider: string): ProviderSearchResult => ({
    text: `Web search results (provider: ${provider}):`,
    resultCount: 1,
  });

  registerWebSearchTools(pi, {
    searchExa: async (params, signal) => {
      calls.push({ provider: "exa", params, hasSignal: signal !== undefined });
      return result("Exa");
    },
    searchDuckDuckGo: async (params, signal) => {
      calls.push({
        provider: "duckduckgo",
        params,
        hasSignal: signal !== undefined,
      });
      return result("DuckDuckGo");
    },
  });

  return { tools, calls };
}

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing registered tool ${name}`);
  return tool;
}

async function execute(
  tool: ToolDefinition,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) {
  return tool.execute("call-1", params, signal, undefined, undefined as never);
}

describe("web search tool definitions", () => {
  it("registers exactly the two documented tools in order", () => {
    const { tools } = setup();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["web_search_exa", "web_search_ddg"],
    );
  });

  // The exact tool prose is documented in docs/SPECIFICATION.md. These tests
  // assert the policy those strings must encode — Exa primary, DuckDuckGo
  // fallback — so the strings can be reworded without a change-detector test,
  // but a silent inversion of the provider order fails.
  it("describes Exa as the primary provider that falls back to DDG", () => {
    const exa = toolByName(setup().tools, "web_search_exa");
    assert.equal(exa.label, "Web Search (Exa)");
    assert.match(exa.promptSnippet ?? "", /primary/i);
    assert.match(exa.description, /primary/i);
    assert.match(exa.description, /first/i);
    assert.match(exa.description, /do not retry/i);
    assert.match(exa.description, /web_search_ddg/);
    assert.ok(exa.promptGuidelines?.length);
    assert.ok(
      exa.promptGuidelines?.some((guideline) =>
        /web_search_ddg/.test(guideline),
      ),
    );
  });

  it("describes DuckDuckGo as the fallback, never the first provider", () => {
    const ddg = toolByName(setup().tools, "web_search_ddg");
    assert.equal(ddg.label, "Web Search (DuckDuckGo)");
    assert.match(ddg.promptSnippet ?? "", /Exa/i);
    assert.match(ddg.description, /fallback/i);
    assert.match(ddg.description, /only use/i);
    assert.match(ddg.description, /routine/i);
    assert.match(ddg.description, /web_search_exa/);
    assert.ok(ddg.promptGuidelines?.length);
    assert.ok(
      ddg.promptGuidelines?.some((guideline) =>
        /web_search_exa/.test(guideline),
      ),
    );
  });
});

describe("web search tool execute wiring", () => {
  it("routes web_search_exa to the Exa provider and normalizes params", async () => {
    const { tools, calls } = setup();
    const output = await execute(toolByName(tools, "web_search_exa"), {
      query: "  hello  ",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].provider, "exa");
    assert.equal(calls[0].params.query, "hello");
    assert.deepEqual(output.details, { provider: "exa", resultCount: 1 });
  });

  it("routes web_search_ddg to the DuckDuckGo provider and normalizes params", async () => {
    const { tools, calls } = setup();
    const output = await execute(toolByName(tools, "web_search_ddg"), {
      query: "hello",
      allowed_domains: ["Example.COM"],
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].provider, "duckduckgo");
    assert.deepEqual(calls[0].params.allowedDomains, ["example.com"]);
    assert.deepEqual(output.details, {
      provider: "duckduckgo",
      resultCount: 1,
    });
  });

  it("forwards the abort signal to the provider", async () => {
    const { tools, calls } = setup();
    const controller = new AbortController();
    await execute(
      toolByName(tools, "web_search_ddg"),
      { query: "hello" },
      controller.signal,
    );
    assert.equal(calls[0].hasSignal, true);
  });

  it("rejects invalid params before calling the provider", async () => {
    const { tools, calls } = setup();
    await assert.rejects(
      execute(toolByName(tools, "web_search_exa"), { query: "a" }),
      /at least 2 characters/,
    );
    assert.equal(calls.length, 0);
  });
});

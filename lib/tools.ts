// The two LLM-callable tools: normative metadata (name, label, description,
// promptSnippet, promptGuidelines) plus the execute wiring that normalizes
// params, calls the injected provider, and shapes the tool result.
//
// Kept out of index.ts so the entry point stays pure registration wiring and
// the tool strings — which encode the Exa-first/DDG-fallback policy and are
// therefore behavior — can be pinned by tests without the Pi runtime.
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSearchParameters, normalizeSearchParams } from "./params.js";
import { formatSearchToolResult } from "./format.js";
import type { NormalizedSearchParams, ProviderSearchResult } from "./types.js";

/** Provider calls injected into the tool definitions, one per search backend. */
export interface WebSearchToolDeps {
  searchExa(
    params: NormalizedSearchParams,
    signal: AbortSignal | undefined,
  ): Promise<ProviderSearchResult>;
  searchDuckDuckGo(
    params: NormalizedSearchParams,
    signal: AbortSignal | undefined,
  ): Promise<ProviderSearchResult>;
}

export function registerWebSearchTools(
  pi: ExtensionAPI,
  deps: WebSearchToolDeps,
): void {
  pi.registerTool({
    name: "web_search_exa",
    label: "Web Search (Exa)",
    description:
      "Primary web search provider. Use web_search_exa first for current information and relevant sources. If Exa reports a quota, rate-limit, or provider error, call web_search_ddg instead; do not retry Exa immediately.",
    promptSnippet: "Search the web with Exa as the primary provider",
    promptGuidelines: [
      "Use web_search_exa first when the user needs current information or web sources.",
      "If web_search_exa reports an error, call web_search_ddg instead of retrying Exa immediately.",
      "Do not call web_search_exa and web_search_ddg for the same query unless the user requests a comparison.",
    ],
    parameters: createSearchParameters(),
    async execute(_toolCallId, params, signal) {
      const normalizedParams = normalizeSearchParams(params);
      const result = await deps.searchExa(normalizedParams, signal);
      return formatSearchToolResult("exa", result);
    },
  });

  pi.registerTool({
    name: "web_search_ddg",
    label: "Web Search (DuckDuckGo)",
    description:
      "Fallback web search provider using DuckDuckGo Lite through Obscura. Only use web_search_ddg when web_search_exa reports an error or when the user explicitly requests DuckDuckGo. Do not use it for routine searches while Exa is available.",
    promptSnippet: "Search the web with DuckDuckGo only after Exa fails",
    promptGuidelines: [
      "Use web_search_ddg only after web_search_exa reports an error or when the user explicitly requests DuckDuckGo.",
      "Do not use web_search_ddg as the first provider for routine searches.",
    ],
    parameters: createSearchParameters(),
    async execute(_toolCallId, params, signal) {
      const normalizedParams = normalizeSearchParams(params);
      const result = await deps.searchDuckDuckGo(normalizedParams, signal);
      return formatSearchToolResult("duckduckgo", result);
    },
  });
}

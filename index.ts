// Extension entry point. The public API is exactly this default factory; the
// tool definitions live in lib/tools.ts and the providers in lib/exa.ts and
// lib/duckduckgo.ts. tests/api-surface.test.ts guards the export surface.
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDuckDuckGoState, createFetchState } from "./lib/policy.js";
import { searchExaForTool } from "./lib/exa.js";
import { searchDuckDuckGoForTool } from "./lib/duckduckgo.js";
import { fetchPageForTool } from "./lib/fetch.js";
import { registerWebTools } from "./lib/tools.js";

export default function (pi: ExtensionAPI) {
  // One shared DuckDuckGo state per extension load: all web_search_ddg calls
  // share its rate limiter, circuit breaker, cache, and in-flight dedup.
  const duckDuckGoState = createDuckDuckGoState();
  // One shared fetch state per extension load: all web_fetch calls share its
  // page cache and in-flight dedup.
  const fetchState = createFetchState();

  registerWebTools(pi, {
    searchExa: searchExaForTool,
    searchDuckDuckGo: (params, signal) =>
      searchDuckDuckGoForTool(params, duckDuckGoState, signal),
    fetchPage: (params, signal) => fetchPageForTool(params, fetchState, signal),
  });
}

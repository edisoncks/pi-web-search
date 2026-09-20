// Extension entry point. The public API is exactly this default factory; the
// tool definitions live in lib/tools.ts and the providers in lib/exa.ts and
// lib/duckduckgo.ts. tests/api-surface.test.ts guards the export surface.
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDuckDuckGoState } from "./lib/policy.js";
import { searchExaForTool } from "./lib/exa.js";
import { searchDuckDuckGoForTool } from "./lib/duckduckgo.js";
import { registerWebSearchTools } from "./lib/tools.js";

export default function (pi: ExtensionAPI) {
  // One shared DuckDuckGo state per extension load: all web_search_ddg calls
  // share its rate limiter, circuit breaker, cache, and in-flight dedup.
  const duckDuckGoState = createDuckDuckGoState();

  registerWebSearchTools(pi, {
    searchExa: searchExaForTool,
    searchDuckDuckGo: (params, signal) =>
      searchDuckDuckGoForTool(params, duckDuckGoState, signal),
  });
}

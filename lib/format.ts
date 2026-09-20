// Output shaping for both providers: numbered result blocks and the Pi host
// truncation wrapper. Kept separate from lib/policy.ts so the request-policy
// module (rate limiting, cache, breaker, dedup, signals) does not also own
// display formatting. Depends on lib/types.js and the pi host package.
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { ProviderSearchResult, WebSearchResult } from "./types.js";

export function formatNumberedResults(
  provider: string,
  results: WebSearchResult[],
): string {
  if (results.length === 0)
    return `No web search results found (provider: ${provider}).`;

  const entries = results.map((result, index) => {
    const lines = [`${index + 1}. ${result.title}`, `   URL: ${result.url}`];
    if (result.snippet) lines.push(`   ${result.snippet}`);
    return lines.join("\n");
  });

  return [`Web search results (provider: ${provider}):`, ...entries].join(
    "\n\n",
  );
}

export function truncateSearchOutput(text: string): string {
  const truncation = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });

  if (!truncation.truncated) return truncation.content;

  return `${truncation.content}\n\n[Search output truncated by pi; reduce numResults or narrow the domain filters.]`;
}

export function formatSearchToolResult(
  provider: string,
  result: ProviderSearchResult,
): {
  content: [{ type: "text"; text: string }];
  details: { provider: string; resultCount: number };
} {
  return {
    // `details.resultCount` is the provider-reported count before this
    // truncation, not the number of result blocks that survive it. The truncation
    // marker tells the model when the visible text is a subset (SPEC §8.3).
    content: [{ type: "text", text: truncateSearchOutput(result.text) }],
    details: {
      provider,
      resultCount: result.resultCount,
    },
  };
}

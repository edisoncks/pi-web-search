// Tool-parameter schema and normalization. Kept out of index.ts so the entry
// point stays pure wiring and this logic stays unit-testable without widening
// the public API.
import { Type } from "typebox";
import {
  DEFAULT_NUM_RESULTS,
  MAX_NUM_RESULTS,
  MIN_QUERY_LENGTH,
  type NormalizedSearchParams,
  type WebSearchParams,
} from "./types.js";
import { normalizeDomains } from "./filter.js";

export function normalizeSearchParams(
  params: WebSearchParams,
): NormalizedSearchParams {
  const query = params.query.trim();
  if (query.length < MIN_QUERY_LENGTH) {
    throw new Error(
      `Search query must be at least ${MIN_QUERY_LENGTH} characters long`,
    );
  }

  const numResults = params.numResults ?? DEFAULT_NUM_RESULTS;
  if (
    !Number.isInteger(numResults) ||
    numResults < 1 ||
    numResults > MAX_NUM_RESULTS
  ) {
    throw new Error(
      `numResults must be an integer between 1 and ${MAX_NUM_RESULTS}`,
    );
  }

  return {
    query,
    allowedDomains: normalizeDomains(params.allowed_domains),
    blockedDomains: normalizeDomains(params.blocked_domains),
    numResults,
  };
}

export function createSearchParameters() {
  return Type.Object({
    query: Type.String({
      minLength: MIN_QUERY_LENGTH,
      description: "Search query, at least two characters long",
    }),
    allowed_domains: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "Only return results from these domains",
      }),
    ),
    blocked_domains: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "Exclude results from these domains",
      }),
    ),
    numResults: Type.Optional(
      Type.Integer({
        default: DEFAULT_NUM_RESULTS,
        minimum: 1,
        maximum: MAX_NUM_RESULTS,
        description: "Maximum number of results to return (default: 8)",
      }),
    ),
  });
}

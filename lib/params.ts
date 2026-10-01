// Tool-parameter schema and normalization. Kept out of index.ts so the entry
// point stays pure wiring and this logic stays unit-testable without widening
// the public API.
import { Type } from "typebox";
import {
  DEFAULT_NUM_RESULTS,
  MAX_FETCH_URLS,
  MAX_NUM_RESULTS,
  MIN_FETCH_URLS,
  MIN_QUERY_LENGTH,
  type NormalizedFetchParams,
  type NormalizedSearchParams,
  type WebFetchParams,
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

/**
 * Normalize one fetch URL. A scheme-less value gets `https://`; anything that
 * still does not parse, or is not `http(s)`, throws `Invalid URL: <value>`.
 */
export function normalizeFetchUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Invalid URL: ${value}`);

  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname
  ) {
    throw new Error(`Invalid URL: ${value}`);
  }
  return parsed.toString();
}

export function normalizeFetchParams(
  params: WebFetchParams,
): NormalizedFetchParams {
  const input = params.urls ?? [];
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const raw of input) {
    if (typeof raw !== "string") throw new Error(`Invalid URL: ${String(raw)}`);
    const url = normalizeFetchUrl(raw);
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }

  if (urls.length < MIN_FETCH_URLS) {
    throw new Error(`At least ${MIN_FETCH_URLS} URL is required`);
  }
  if (urls.length > MAX_FETCH_URLS) {
    throw new Error(`At most ${MAX_FETCH_URLS} URLs can be fetched per call`);
  }

  return { urls };
}

export function createFetchParameters() {
  return Type.Object({
    urls: Type.Array(Type.String({ minLength: 1 }), {
      minItems: MIN_FETCH_URLS,
      maxItems: MAX_FETCH_URLS,
      description:
        "Absolute http(s) URLs to fetch (1-5). Use the URLs returned by a web search.",
    }),
  });
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

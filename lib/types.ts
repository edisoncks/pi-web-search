// Shared scalar constants, interfaces, and the isRecord guard.
// No imports: every other lib module may depend on this file.

export const DEFAULT_NUM_RESULTS = 8;
export const MAX_NUM_RESULTS = 20;
export const MIN_QUERY_LENGTH = 2;
export const REQUEST_TIMEOUT_MS = 15_000;

// web_fetch limits. One call reads a small batch of pages; each page is capped
// in characters so a single call cannot flood the model's context.
export const MIN_FETCH_URLS = 1;
export const MAX_FETCH_URLS = 5;
export const FETCH_TIMEOUT_MS = 30_000;
export const FETCH_MAX_PAGE_CHARS = 4_000;
export const FETCH_CONCURRENCY = 3;
export const FETCH_CACHE_TTL_MS = 10 * 60_000;
export const FETCH_CACHE_MAX_ENTRIES = 64;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchParams {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
  numResults?: number;
}

export interface NormalizedSearchParams {
  query: string;
  allowedDomains: string[];
  blockedDomains: string[];
  numResults: number;
}

export interface ProviderSearchResult {
  text: string;
  resultCount: number;
}

export interface WebFetchParams {
  urls: string[];
}

export interface NormalizedFetchParams {
  urls: string[];
}

/** A successfully fetched page: `content` is already capped and trimmed. */
export interface FetchedPage {
  status: "ok";
  url: string;
  content: string;
  truncated: boolean;
}

/** A single URL that could not be read. The batch still succeeds. */
export interface FailedFetch {
  status: "error";
  url: string;
  error: string;
}

export type FetchOutcome = FetchedPage | FailedFetch;

export interface DuckDuckGoCacheEntry {
  results: WebSearchResult[];
  expiresAt: number;
}

export interface DuckDuckGoState {
  requestQueue: Promise<void>;
  nextRequestAt: number;
  unavailableUntil: number;
  cache: Map<string, DuckDuckGoCacheEntry>;
  inFlight: Map<string, Promise<WebSearchResult[]>>;
}

export interface FetchCacheEntry {
  page: FetchedPage;
  expiresAt: number;
}

export interface FetchState {
  cache: Map<string, FetchCacheEntry>;
  inFlight: Map<string, Promise<FetchedPage>>;
}

export interface McpRpcResponse {
  result?: McpToolResult;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export interface McpToolResult {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export interface ExaStructuredResult {
  title: string;
  url: string;
  snippet: string;
}

export type DuckDuckGoClassification =
  | { kind: "results"; results: WebSearchResult[] }
  | { kind: "challenge"; reason: string }
  | { kind: "drift" }
  | { kind: "empty" };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

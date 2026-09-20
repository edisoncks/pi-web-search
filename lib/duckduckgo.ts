// DuckDuckGo provider: lite-HTML fetch through Obscura plus result parsing.
// Depends on lib/types.js (types), lib/filter.js (domain match),
// lib/policy.js (state, slot, errors, signals), lib/format.js (output).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { REQUEST_TIMEOUT_MS } from "./types.js";
import type {
  DuckDuckGoClassification,
  DuckDuckGoState,
  NormalizedSearchParams,
  ProviderSearchResult,
  WebSearchResult,
} from "./types.js";
import { isDomainMatch } from "./filter.js";
import {
  getSearchSignal,
  errorMessage,
  shortErrorMessage,
  waitWithSignal,
  waitForPromiseWithSignal,
  randomJitter,
  DDG_JITTER_MS,
  markDuckDuckGoUnavailable,
  withDuckDuckGoRequestSlot,
  isRetryableDuckDuckGoError,
  getDuckDuckGoCacheKey,
  getCachedDuckDuckGoResults,
  cacheDuckDuckGoResults,
  DuckDuckGoUnavailableError,
  DuckDuckGoDriftError,
  UnsupportedRuntimeError,
  type AbortSignalStatics,
} from "./policy.js";
import { formatNumberedResults } from "./format.js";

const execFileAsync = promisify(execFile);

const DDG_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const OBSCURA_COMMAND = "obscura";
const DDG_MAX_RETRIES = 1;
const DDG_RETRY_BASE_MS = 1_000;
const DUCKDUCKGO_URL = "https://lite.duckduckgo.com/lite";

// A result-shaped redirect: `uddg=` carrying an http(s) target. Requiring the
// target scheme keeps an unrelated non-web `uddg=` nav link on a no-results
// page from being misreported as parser drift.
const DDG_RESULT_REDIRECT = /uddg=(?:https?%3A%2F%2F|https?:\/\/)/iu;

export function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value
    .replace(/&#x([0-9a-f]+);/giu, (_match: string, hex: string) => {
      try {
        return String.fromCodePoint(Number.parseInt(hex, 16));
      } catch {
        return _match;
      }
    })
    .replace(/&#(\d+);/gu, (_match: string, decimal: string) => {
      try {
        return String.fromCodePoint(Number.parseInt(decimal, 10));
      } catch {
        return _match;
      }
    })
    .replace(/&([a-z]+);/giu, (match: string, name: string) => {
      return namedEntities[name.toLowerCase()] ?? match;
    });
}

export function stripHtml(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
      .replace(/<br\s*\/?>/giu, " ")
      .replace(/<[^>]*>/gu, " "),
  )
    .replace(/\s+/gu, " ")
    .trim();
}

function isDuckDuckGoHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "duckduckgo.com" || host.endsWith(".duckduckgo.com");
}

export function resolveDuckDuckGoResultUrl(href: string): string | undefined {
  try {
    const link = new URL(decodeHtmlEntities(href), "https://duckduckgo.com");
    const dest = link.searchParams.get("uddg");
    if (!dest) {
      // Never surface duckduckgo.com navigation links as results.
      if (isDuckDuckGoHostname(link.hostname)) return undefined;
      if (link.protocol !== "http:" && link.protocol !== "https:")
        return undefined;
      return link.toString();
    }
    let target: URL;
    try {
      target = new URL(dest, "https://duckduckgo.com");
    } catch {
      return undefined;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:")
      return undefined;
    if (isDuckDuckGoHostname(target.hostname)) return undefined;
    return target.toString();
  } catch {
    return undefined;
  }
}

function filterResultsByDomain(
  results: WebSearchResult[],
  allowedDomains: string[],
  blockedDomains: string[],
): WebSearchResult[] {
  return results.filter(
    (result) =>
      !isDomainMatch(result.url, blockedDomains) &&
      (allowedDomains.length === 0 ||
        isDomainMatch(result.url, allowedDomains)),
  );
}

/** Extract every resolvable result, before any domain filtering. */
function extractDuckDuckGoResults(html: string): WebSearchResult[] {
  const resultLinkPattern =
    /<a\b[^>]*\bclass\s*=\s*(['"])[^'"]*\bresult-link\b[^'"]*\1[^>]*>([\s\S]*?)<\/a>/giu;
  const matches = [...html.matchAll(resultLinkPattern)];
  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const hrefMatch = match[0].match(/\bhref\s*=\s*(['"])([\s\S]*?)\1/iu);
    const url = hrefMatch
      ? resolveDuckDuckGoResultUrl(hrefMatch[2])
      : undefined;
    if (!url || seenUrls.has(url)) continue;

    const sectionStart = (match.index ?? 0) + match[0].length;
    const sectionEnd = matches[index + 1]?.index ?? html.length;
    const section = html.slice(sectionStart, sectionEnd);
    const snippetMatch = section.match(
      /<td\b[^>]*\bclass\s*=\s*(['"])[^'"]*\bresult-snippet\b[^'"]*\1[^>]*>([\s\S]*?)<\/td>/iu,
    );

    seenUrls.add(url);
    results.push({
      title: stripHtml(match[2]),
      url,
      snippet: snippetMatch ? stripHtml(snippetMatch[2]) : "",
    });
  }

  return results;
}

export function classifyDuckDuckGoResponse(
  html: string,
  allowedDomains: string[] = [],
  blockedDomains: string[] = [],
): DuckDuckGoClassification {
  // Callers pass domain lists already normalized by normalizeSearchParams, so
  // this classifier trusts them instead of normalizing a second time.
  //
  // Classification must be decided before domain filtering: filtering every
  // result away is an empty success, not evidence that the parser drifted.
  const extracted = extractDuckDuckGoResults(html);
  if (extracted.length > 0) {
    return {
      kind: "results",
      results: filterResultsByDomain(extracted, allowedDomains, blockedDomains),
    };
  }

  const challenge = detectDuckDuckGoChallenge(html);
  if (challenge) return { kind: "challenge", reason: challenge };
  if (DDG_RESULT_REDIRECT.test(html)) return { kind: "drift" };
  return { kind: "empty" };
}

export function detectDuckDuckGoChallenge(html: string): string | undefined {
  // Structural markers only. Callers gate this on zero parsed results so that
  // snippet text (e.g. a search about "HTTP 429") can never trip the breaker.
  if (
    /challenge-form|anomaly|captcha|Unfortunately, bots use DuckDuckGo/iu.test(
      html,
    )
  ) {
    return "DuckDuckGo returned an anti-bot challenge page";
  }
  return undefined;
}

export function buildDuckDuckGoQuery(params: NormalizedSearchParams): string {
  const queryParts = [params.query];

  if (params.allowedDomains.length > 0) {
    queryParts.push(
      `(${params.allowedDomains.map((domain) => `site:${domain}`).join(" OR ")})`,
    );
  }
  queryParts.push(...params.blockedDomains.map((domain) => `-site:${domain}`));

  return queryParts.join(" ");
}

/**
 * Build the Obscura argv (after the binary name) for a DuckDuckGo lite fetch.
 * Pure: no process is spawned. The URL embeds the composed query.
 */
export function buildObscuraArgs(params: NormalizedSearchParams): string[] {
  const url = new URL(DUCKDUCKGO_URL);
  url.searchParams.set("q", buildDuckDuckGoQuery(params));

  return [
    "--stealth",
    "fetch",
    url.toString(),
    "--dump",
    "html",
    "--quiet",
    "--wait",
    "0",
    "--timeout",
    String(Math.ceil(REQUEST_TIMEOUT_MS / 1_000)),
  ];
}

export async function fetchDuckDuckGoAttempt(
  params: NormalizedSearchParams,
  state: DuckDuckGoState,
  signal: AbortSignal | undefined,
): Promise<WebSearchResult[]> {
  const { stdout } = await execFileAsync(
    OBSCURA_COMMAND,
    buildObscuraArgs(params),
    {
      encoding: "utf8",
      maxBuffer: DDG_MAX_OUTPUT_BYTES,
      // fetchDuckDuckGoWithRetry owns the single per-search deadline and passes
      // it down; execFile gets that one signal and no separate `timeout` option
      // racing the same child process.
      signal,
    },
  );
  const html = stdout;
  if (!html.trim()) {
    throw new Error("Obscura returned empty DuckDuckGo HTML");
  }

  const classification = classifyDuckDuckGoResponse(
    html,
    params.allowedDomains,
    params.blockedDomains,
  );

  if (classification.kind === "challenge") {
    const retryAt = markDuckDuckGoUnavailable(state);
    throw new DuckDuckGoUnavailableError(classification.reason, retryAt);
  }
  if (classification.kind === "drift") {
    // Deterministic: same markup will fail identically on retry. Fail fast
    // with no cooldown (this is not rate-limiting) and no retry.
    throw new DuckDuckGoDriftError(
      "DuckDuckGo returned results but none could be parsed; its markup likely changed. Use web_search_exa for this search.",
    );
  }

  return classification.kind === "results" ? classification.results : [];
}

/** Injectable for tests: perform one DuckDuckGo fetch attempt. */
export type DuckDuckGoAttempt = (
  params: NormalizedSearchParams,
  state: DuckDuckGoState,
  signal: AbortSignal | undefined,
) => Promise<WebSearchResult[]>;

export async function fetchDuckDuckGoWithRetry(
  params: NormalizedSearchParams,
  state: DuckDuckGoState,
  signal: AbortSignal | undefined,
  fetchAttempt: DuckDuckGoAttempt = fetchDuckDuckGoAttempt,
  statics: AbortSignalStatics = AbortSignal,
): Promise<WebSearchResult[]> {
  // One deadline for the whole search, created here because this runs inside
  // the signal-less shared flight. Every retry attempt and the backoff between
  // them share it, so retries cannot extend the caller-visible bound.
  const requestSignal = getSearchSignal(signal, statics);

  for (let attempt = 0; attempt <= DDG_MAX_RETRIES; attempt += 1) {
    try {
      return await withDuckDuckGoRequestSlot(state, requestSignal, () =>
        fetchAttempt(params, state, requestSignal),
      );
    } catch (error) {
      if (
        signal?.aborted ||
        attempt >= DDG_MAX_RETRIES ||
        !isRetryableDuckDuckGoError(error)
      ) {
        throw error;
      }

      await waitWithSignal(
        DDG_RETRY_BASE_MS * 2 ** attempt + randomJitter(DDG_JITTER_MS),
        requestSignal,
      );
    }
  }

  throw new Error("DuckDuckGo request failed");
}

/** Injectable for tests: fetch the raw result set for a query. */
export type DuckDuckGoFetch = (
  params: NormalizedSearchParams,
  state: DuckDuckGoState,
  signal: AbortSignal | undefined,
) => Promise<WebSearchResult[]>;

export async function searchDuckDuckGo(
  params: NormalizedSearchParams,
  state: DuckDuckGoState,
  signal: AbortSignal | undefined,
  fetchResults?: DuckDuckGoFetch,
  statics: AbortSignalStatics = AbortSignal,
): Promise<ProviderSearchResult> {
  // Bind the injected statics into the default fetch so a caller that swaps
  // them (tests) reaches the same fetch path the default would take.
  const fetchPage =
    fetchResults ??
    ((fetchParams, fetchState, fetchSignal) =>
      fetchDuckDuckGoWithRetry(
        fetchParams,
        fetchState,
        fetchSignal,
        fetchDuckDuckGoAttempt,
        statics,
      ));
  const results = await getDuckDuckGoResults(params, state, signal, fetchPage);
  const sliced = results.slice(0, params.numResults);
  return {
    text: formatNumberedResults("DuckDuckGo", sliced),
    resultCount: sliced.length,
  };
}

/**
 * Return the cached or fetched result set for a query, independent of
 * `numResults`, so one DuckDuckGo page serves every result count for the same
 * query instead of fetching once per count.
 */
async function getDuckDuckGoResults(
  params: NormalizedSearchParams,
  state: DuckDuckGoState,
  signal: AbortSignal | undefined,
  fetchResults: DuckDuckGoFetch,
): Promise<WebSearchResult[]> {
  const key = getDuckDuckGoCacheKey(params);
  const cached = getCachedDuckDuckGoResults(state, key);
  if (cached) return cached;

  const pending = state.inFlight.get(key);
  if (pending) return waitForPromiseWithSignal(pending, signal);

  // Shared work must not be tied to any single waiter's signal: the first
  // caller's abort must not reject co-waiters. Cache on the shared promise and
  // keep the in-flight entry until that promise settles, so an aborting creator
  // cannot delete it and let a duplicate fetch start.
  const request = fetchResults(params, state, undefined).then((results) => {
    cacheDuckDuckGoResults(state, key, results);
    return results;
  });
  const tracked = request.finally(() => {
    if (state.inFlight.get(key) === tracked) state.inFlight.delete(key);
  });
  state.inFlight.set(key, tracked);

  return waitForPromiseWithSignal(tracked, signal);
}

export async function searchDuckDuckGoForTool(
  params: NormalizedSearchParams,
  state: DuckDuckGoState,
  signal: AbortSignal | undefined,
  statics: AbortSignalStatics = AbortSignal,
): Promise<ProviderSearchResult> {
  try {
    return await searchDuckDuckGo(params, state, signal, undefined, statics);
  } catch (error) {
    if (signal?.aborted || error instanceof UnsupportedRuntimeError)
      throw error;
    throw createDuckDuckGoSearchError(error);
  }
}

export function createDuckDuckGoSearchError(error: unknown): Error {
  if (
    /spawn obscura ENOENT|ENOENT.*obscura|obscura.*not found/iu.test(
      errorMessage(error),
    )
  ) {
    return new Error(
      `obscura not found on PATH (required for web_search_ddg); install obscura or use web_search_exa instead. (${shortErrorMessage(error)})`,
    );
  }
  return new Error(
    `DuckDuckGo web search is unavailable (${shortErrorMessage(error)}). Use web_search_exa if it has not already failed; do not retry DuckDuckGo immediately.`,
  );
}

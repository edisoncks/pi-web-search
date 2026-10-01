// Page-fetch provider: resolve URLs to readable page content through the
// external Obscura CLI. Depends on lib/types.js (types), lib/policy.js (state,
// signals, errors), lib/format.js (output).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  FETCH_CONCURRENCY,
  FETCH_MAX_PAGE_CHARS,
  FETCH_TIMEOUT_MS,
  type FetchedPage,
  type FetchOutcome,
  type FetchState,
  type NormalizedFetchParams,
  type ProviderSearchResult,
} from "./types.js";
import {
  cacheFetchPage,
  getCachedFetchPage,
  getFetchSignal,
  isAbortError,
  isObscuraMissingError,
  shortErrorMessage,
  waitForPromiseWithSignal,
} from "./policy.js";
import { formatFetchedPages } from "./format.js";

const execFileAsync = promisify(execFile);

const FETCH_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const OBSCURA_COMMAND = "obscura";

/**
 * Build the Obscura argv (after the binary name) for one page fetch. Pure: no
 * process is spawned. `--dump markdown` is the readable text extraction; the
 * adaptive settle default (5 s cap) is kept so JS-rendered content is present,
 * unlike the DuckDuckGo fetch which wants the page before it settles.
 */
export function buildObscuraFetchArgs(url: string): string[] {
  return [
    "--stealth",
    "fetch",
    url,
    "--dump",
    "markdown",
    "--quiet",
    "--timeout",
    String(Math.ceil(FETCH_TIMEOUT_MS / 1_000)),
  ];
}

/** Cut at `max` characters without leaving a dangling surrogate half. */
export function truncatePageContent(
  value: string,
  max: number,
): { content: string; truncated: boolean } {
  if (value.length <= max) return { content: value, truncated: false };
  let end = max;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { content: value.slice(0, end), truncated: true };
}

/** Injectable for tests: perform one page fetch. */
export type FetchAttempt = (
  url: string,
  signal: AbortSignal | undefined,
) => Promise<FetchedPage>;

export async function fetchPageAttempt(
  url: string,
  signal: AbortSignal | undefined,
): Promise<FetchedPage> {
  const { stdout } = await execFileAsync(
    OBSCURA_COMMAND,
    buildObscuraFetchArgs(url),
    {
      encoding: "utf8",
      maxBuffer: FETCH_MAX_OUTPUT_BYTES,
      // fetchPagesForTool owns the authoritative batch deadline and passes it
      // down as this signal. Obscura also has its own `--timeout` backstop (see
      // buildObscuraFetchArgs); no separate execFile timeout is set, so the
      // child is not raced by a third timer.
      signal,
    },
  );
  const text = stdout.trim();
  if (!text) throw new Error("Obscura returned an empty page");
  const { content, truncated } = truncatePageContent(
    text,
    FETCH_MAX_PAGE_CHARS,
  );
  return { status: "ok", url, content, truncated };
}

/**
 * Return the cached, in-flight, or freshly fetched page for one URL. The shared
 * work is started without any caller's signal (as in the DuckDuckGo provider),
 * so one waiter's abort cannot reject a co-waiter.
 */
export async function fetchPage(
  url: string,
  state: FetchState,
  signal: AbortSignal | undefined,
  attempt: FetchAttempt = fetchPageAttempt,
): Promise<FetchedPage> {
  const cached = getCachedFetchPage(state, url);
  if (cached) return cached;

  const pending = state.inFlight.get(url);
  if (pending) return waitForPromiseWithSignal(pending, signal);

  const request = attempt(url, undefined).then((page) => {
    cacheFetchPage(state, url, page);
    return page;
  });
  const tracked = request.finally(() => {
    if (state.inFlight.get(url) === tracked) state.inFlight.delete(url);
  });
  state.inFlight.set(url, tracked);

  return waitForPromiseWithSignal(tracked, signal);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await operation(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function describeFetchError(error: unknown): string {
  if (isAbortError(error)) return "timed out";
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "timed out";
  }
  return shortErrorMessage(error) || "fetch failed";
}

/**
 * The PATH hint for a missing `obscura`. A missing binary is the one failure
 * that fails the whole batch: every URL would fail identically, so a per-URL
 * error per entry would just repeat the same message N times.
 */
export function createMissingObscuraError(error: unknown): Error {
  return new Error(
    `obscura not found on PATH (required for web_fetch); install obscura or use web_search_exa instead. (${shortErrorMessage(error)})`,
  );
}

/**
 * Fetch every URL in the batch. A single URL's failure becomes a per-entry
 * error so the others still return; a caller abort or a missing Obscura binary
 * fails the whole call. The batch shares one deadline.
 */
export async function fetchPagesForTool(
  params: NormalizedFetchParams,
  state: FetchState,
  signal: AbortSignal | undefined,
  attempt: FetchAttempt = fetchPageAttempt,
): Promise<ProviderSearchResult> {
  const requestSignal = getFetchSignal(signal);

  const outcomes = await mapWithConcurrency<string, FetchOutcome>(
    params.urls,
    FETCH_CONCURRENCY,
    async (url): Promise<FetchOutcome> => {
      try {
        return await fetchPage(url, state, requestSignal, attempt);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (isObscuraMissingError(error)) {
          throw createMissingObscuraError(error);
        }
        return { status: "error", url, error: describeFetchError(error) };
      }
    },
  );

  const pageCount = outcomes.filter(
    (outcome) => outcome.status === "ok",
  ).length;
  return {
    text: formatFetchedPages(outcomes),
    resultCount: pageCount,
  };
}

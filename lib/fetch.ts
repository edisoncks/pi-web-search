// Page-fetch provider: resolve URLs to readable page content through the
// external Obscura CLI. Depends on lib/types.js (types), lib/policy.js (state,
// signals, errors), lib/format.js (output).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
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
  UnsupportedRuntimeError,
  waitForPromiseWithSignal,
  withFetchSlot,
} from "./policy.js";
import { formatFetchedPage } from "./format.js";

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
      // The shared fetch owns the authoritative 30 s deadline and passes it down
      // as this signal. Obscura also has its own `--timeout` backstop (see
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

  // The shared work owns the fetch deadline and the global slot, not any
  // caller: an aborting caller releases nothing, and the slot is held until the
  // child process settles.
  const request = withFetchSlot(state, undefined, () =>
    attempt(url, getFetchSignal(undefined)),
  ).then((page) => {
    cacheFetchPage(state, url, page);
    return page;
  });
  const tracked = request.finally(() => {
    if (state.inFlight.get(url) === tracked) state.inFlight.delete(url);
  });
  state.inFlight.set(url, tracked);

  return waitForPromiseWithSignal(tracked, signal);
}

function describeFetchError(error: unknown): string {
  if (isAbortError(error)) return "timed out";
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "timed out";
  }
  return shortErrorMessage(error) || "fetch failed";
}

/**
 * The PATH hint for a missing `obscura`. A missing binary fails the whole
 * call, because no URL could have been fetched anyway.
 */
export function createMissingObscuraError(error: unknown): Error {
  return new Error(
    `obscura not found on PATH (required for web_fetch); install obscura or use web_search_exa instead. (${shortErrorMessage(error)})`,
  );
}

/**
 * Fetch one URL for the tool. The failure is reported in place, except for a
 * caller abort (which propagates) and a missing Obscura binary (which fails the
 * whole call with the PATH hint).
 */
export async function fetchPageForTool(
  params: NormalizedFetchParams,
  state: FetchState,
  signal: AbortSignal | undefined,
  attempt: FetchAttempt = fetchPageAttempt,
): Promise<ProviderSearchResult> {
  let outcome: FetchOutcome;
  try {
    outcome = await fetchPage(params.url, state, signal, attempt);
  } catch (error) {
    if (signal?.aborted) throw error;
    // An unsupported runtime is an environment fault, not a failed page
    // (§0); rethrow it like the search wrappers do.
    if (error instanceof UnsupportedRuntimeError) throw error;
    if (isObscuraMissingError(error)) {
      throw createMissingObscuraError(error);
    }
    outcome = {
      status: "error",
      url: params.url,
      error: describeFetchError(error),
    };
  }

  return {
    text: formatFetchedPage(outcome),
    resultCount: outcome.status === "ok" ? 1 : 0,
  };
}

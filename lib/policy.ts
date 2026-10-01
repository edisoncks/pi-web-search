// Rate limiting, caching, circuit breaking, request dedup, and abort-aware
// signal helpers. Depends only on lib/types.js. Output formatting lives in
// lib/format.ts so this module stays about request policy.
/* eslint-disable @typescript-eslint/prefer-promise-reject-errors --
   AbortSignal.reason is an arbitrary value by spec and must be rethrown
   verbatim; wrapping it would rewrite an aborted caller's error. */
import {
  FETCH_CACHE_MAX_ENTRIES,
  FETCH_CACHE_TTL_MS,
  FETCH_CONCURRENCY,
  FETCH_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
} from "./types.js";
import type {
  DuckDuckGoState,
  FetchedPage,
  FetchSlotWaiter,
  FetchState,
  NormalizedSearchParams,
  WebSearchResult,
} from "./types.js";

export const DDG_MIN_PAUSE_MS = 3_000;
export const DDG_JITTER_MS = 1_000;
export const DDG_CACHE_TTL_MS = 10 * 60_000;
export const DDG_CACHE_MAX_ENTRIES = 64;
export const DDG_COOLDOWN_MS = 10 * 60_000;
export const DDG_MAX_COOLDOWN_MS = 15 * 60_000;

export class DuckDuckGoUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryAt: number,
  ) {
    super(message);
    this.name = "DuckDuckGoUnavailableError";
  }
}

export class DuckDuckGoDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuckDuckGoDriftError";
  }
}

/**
 * The host is running a Node too old for `AbortSignal.timeout`/`any`. This is
 * an environment fault, not a provider fault, so both `search*ForTool` wrappers
 * rethrow it unchanged instead of rewriting it into a provider error.
 */
export class UnsupportedRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedRuntimeError";
  }
}

export function createDuckDuckGoState(): DuckDuckGoState {
  return {
    requestQueue: Promise.resolve(),
    nextRequestAt: 0,
    unavailableUntil: 0,
    cache: new Map(),
    inFlight: new Map(),
  };
}

export function createFetchState(): FetchState {
  return {
    cache: new Map(),
    inFlight: new Map(),
    active: 0,
    waiters: [],
  };
}

/**
 * The two `AbortSignal` statics the runtime guard needs. Injectable so tests
 * can simulate an older runtime without mutating the global `AbortSignal`.
 */
export type AbortSignalStatics = Pick<typeof AbortSignal, "timeout" | "any">;

/**
 * Throw `UnsupportedRuntimeError` when the host lacks
 * `AbortSignal.timeout`/`AbortSignal.any`. This is an environment fault, not a
 * provider fault, so both `search*ForTool` wrappers rethrow it unchanged.
 */
export function assertSupportedRuntime(
  statics: AbortSignalStatics = AbortSignal,
): void {
  if (
    typeof statics.timeout !== "function" ||
    typeof statics.any !== "function"
  ) {
    throw new UnsupportedRuntimeError(
      "pi-web-search requires Node >=22.19.0 (AbortSignal.timeout/any is unavailable)",
    );
  }
}

/**
 * Combine the caller's signal with the one timeout shared by every network
 * round trip of a single search. Call this once per search, not once per
 * request, so the 15 s bound applies to the whole search instead of resetting
 * on every handshake and retry round trip.
 */
function combineWithTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  statics: AbortSignalStatics,
): AbortSignal {
  assertSupportedRuntime(statics);
  const timeoutSignal = statics.timeout(timeoutMs);
  return signal ? statics.any([signal, timeoutSignal]) : timeoutSignal;
}

/**
 * Combine the caller's signal with the one timeout shared by every network
 * round trip of a single search. Call this once per search, not once per
 * request, so the 15 s bound applies to the whole search instead of resetting
 * on every handshake and retry round trip.
 */
export function getSearchSignal(
  signal: AbortSignal | undefined,
  statics: AbortSignalStatics = AbortSignal,
): AbortSignal {
  return combineWithTimeout(signal, REQUEST_TIMEOUT_MS, statics);
}

/**
 * The fetch equivalent of `getSearchSignal`: the timeout the shared work for
 * one URL owns, so a co-waiter cannot reset the bound.
 */
export function getFetchSignal(
  signal: AbortSignal | undefined,
  statics: AbortSignalStatics = AbortSignal,
): AbortSignal {
  return combineWithTimeout(signal, FETCH_TIMEOUT_MS, statics);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function shortErrorMessage(error: unknown): string {
  return errorMessage(error).replace(/\s+/gu, " ").slice(0, 300);
}

const OBSCURA_MISSING_PATTERN =
  /spawn obscura ENOENT|ENOENT.*obscura|obscura.*not found/iu;

/**
 * Whether a failure means the `obscura` binary is not on `PATH`. Both the
 * DuckDuckGo provider and the page-fetch provider depend on it, so the
 * detection lives here instead of being duplicated per provider.
 */
export function isObscuraMissingError(error: unknown): boolean {
  return OBSCURA_MISSING_PATTERN.test(errorMessage(error));
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}

export function waitWithSignal(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  if (ms <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(
        signal?.reason ??
          new DOMException("The operation was aborted", "AbortError"),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function waitForPromiseWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      finish();
    };
    const onAbort = () => {
      settle(() =>
        reject(
          signal.reason ??
            new DOMException("The operation was aborted", "AbortError"),
        ),
      );
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

export function randomJitter(maxMs: number): number {
  return Math.floor(Math.random() * (maxMs + 1));
}

export function clampCooldown(delayMs: number): number {
  return Math.min(Math.max(delayMs, DDG_COOLDOWN_MS), DDG_MAX_COOLDOWN_MS);
}

export function markDuckDuckGoUnavailable(
  state: DuckDuckGoState,
  delayMs = DDG_COOLDOWN_MS,
): number {
  const retryAt = Date.now() + clampCooldown(delayMs);
  state.unavailableUntil = Math.max(state.unavailableUntil, retryAt);
  return state.unavailableUntil;
}

export function createCircuitOpenError(
  state: DuckDuckGoState,
): DuckDuckGoUnavailableError {
  const retryAt = state.unavailableUntil;
  const seconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1_000));
  return new DuckDuckGoUnavailableError(
    `DuckDuckGo is temporarily unavailable; retry in about ${seconds}s`,
    retryAt,
  );
}

export async function withDuckDuckGoRequestSlot<T>(
  state: DuckDuckGoState,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = state.requestQueue;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The next waiter must wait for both this attempt's gate and its predecessor,
  // so a waiter that aborts while queued cannot free the slot while the current
  // holder is still in flight. The predecessor is always a gate chain and never
  // rejects, but pass a rejection through so a future change cannot poison the
  // queue and starve every waiter behind it.
  state.requestQueue = previous.then(
    () => gate,
    () => gate,
  );

  try {
    await waitForPromiseWithSignal(previous, signal);
    throwIfAborted(signal);
    if (state.unavailableUntil > Date.now()) {
      throw createCircuitOpenError(state);
    }

    const spacing = Math.max(0, state.nextRequestAt - Date.now());
    await waitWithSignal(spacing, signal);
    throwIfAborted(signal);

    const result = await operation();
    // Spacing penalty applies to completed attempts only. Deterministic
    // failures (drift/challenge/abort) fail fast with no penalty; the
    // circuit breaker owns cooldowns for rate-limit cases.
    state.nextRequestAt =
      Date.now() + DDG_MIN_PAUSE_MS + randomJitter(DDG_JITTER_MS);
    return result;
  } finally {
    release();
  }
}

/** Whether a failure is an abort/timeout rather than a real provider fault. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
}

export function isRetryableDuckDuckGoError(error: unknown): boolean {
  if (error instanceof DuckDuckGoUnavailableError) return false;
  if (error instanceof DuckDuckGoDriftError) return false;
  if (error instanceof UnsupportedRuntimeError) return false;
  if (isAbortError(error)) return false;
  return true;
}

export function getDuckDuckGoCacheKey(params: NormalizedSearchParams): string {
  // numResults is intentionally absent: DuckDuckGo Lite returns a fixed page
  // and the caller slices it, so counting it here would fetch the same page
  // twice for two different result counts.
  //
  // The domain arrays are sorted so the same filters in a different order map
  // to the same cache entry instead of fetching the identical page twice.
  return JSON.stringify({
    query: params.query,
    allowedDomains: [...params.allowedDomains].sort(),
    blockedDomains: [...params.blockedDomains].sort(),
  });
}

export function getCachedDuckDuckGoResults(
  state: DuckDuckGoState,
  key: string,
): WebSearchResult[] | undefined {
  const entry = state.cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    state.cache.delete(key);
    return undefined;
  }
  return entry.results;
}

export function cacheDuckDuckGoResults(
  state: DuckDuckGoState,
  key: string,
  results: WebSearchResult[],
): void {
  const now = Date.now();
  for (const [entryKey, entry] of state.cache) {
    if (entry.expiresAt <= now) state.cache.delete(entryKey);
  }

  state.cache.delete(key);
  state.cache.set(key, {
    results,
    expiresAt: now + DDG_CACHE_TTL_MS,
  });

  while (state.cache.size > DDG_CACHE_MAX_ENTRIES) {
    const oldestKey = state.cache.keys().next().value;
    if (oldestKey === undefined) break;
    state.cache.delete(oldestKey);
  }
}

export function getCachedFetchPage(
  state: FetchState,
  url: string,
): FetchedPage | undefined {
  const entry = state.cache.get(url);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    state.cache.delete(url);
    return undefined;
  }
  return entry.page;
}

/** Cache a fetched page, evicting expired entries and the oldest over the cap. */
export function cacheFetchPage(
  state: FetchState,
  url: string,
  page: FetchedPage,
): void {
  const now = Date.now();
  for (const [entryKey, entry] of state.cache) {
    if (entry.expiresAt <= now) state.cache.delete(entryKey);
  }

  state.cache.delete(url);
  state.cache.set(url, {
    page,
    expiresAt: now + FETCH_CACHE_TTL_MS,
  });

  while (state.cache.size > FETCH_CACHE_MAX_ENTRIES) {
    const oldestKey = state.cache.keys().next().value;
    if (oldestKey === undefined) break;
    state.cache.delete(oldestKey);
  }
}

function acquireFetchSlot(
  state: FetchState,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  if (state.active < FETCH_CONCURRENCY) {
    state.active += 1;
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const waiter: FetchSlotWaiter = { resolve, cleanup: () => {} };
    const onAbort = () => {
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) state.waiters.splice(index, 1);
      waiter.cleanup();
      reject(
        signal?.reason ??
          new DOMException("The operation was aborted", "AbortError"),
      );
    };
    waiter.cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
    state.waiters.push(waiter);
  });
}

function releaseFetchSlot(state: FetchState): void {
  const next = state.waiters.shift();
  if (!next) {
    state.active = Math.max(0, state.active - 1);
    return;
  }
  // Hand the slot straight to the next waiter, so `active` is unchanged.
  // Clean up before resolving so a late abort cannot reject a fetch that has
  // already been granted its slot.
  next.cleanup();
  next.resolve();
}

/**
 * A global concurrency gate for page fetches. The limit lives on the shared
 * `FetchState`, so it bounds Obscura processes across every concurrent
 * `web_fetch` call, not just the URLs of one call. A waiter that aborts while
 * queued is removed without freeing a slot it never held; a running holder
 * releases its slot only when its operation settles.
 */
export async function withFetchSlot<T>(
  state: FetchState,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  await acquireFetchSlot(state, signal);
  try {
    throwIfAborted(signal);
    return await operation();
  } finally {
    releaseFetchSlot(state);
  }
}

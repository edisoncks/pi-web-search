// Single source of truth for the package version reported to providers.
// Read from package.json at runtime so there is nothing to keep in sync by
// hand and no build step is required. A missing or unreadable manifest must
// never take down the extension, so resolution falls back to a sentinel.
import { readFileSync } from "node:fs";
import { isRecord } from "./types.js";

/** Reported when the manifest is missing or unreadable. */
export const UNKNOWN_PACKAGE_VERSION = "0.0.0-unknown";

/** Parse the `version` field out of package.json text, or `undefined`. */
export function parsePackageVersion(text: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (
      isRecord(raw) &&
      typeof raw.version === "string" &&
      raw.version.trim()
    ) {
      return raw.version.trim();
    }
  } catch {
    // Malformed JSON is treated the same as a missing version.
  }
  return undefined;
}

/**
 * Read the package version, falling back to `UNKNOWN_PACKAGE_VERSION` when the
 * manifest is missing or unreadable. This runs at import time and every
 * provider depends on the module, so it must not throw.
 */
export function readPackageVersion(
  manifestUrl: URL = new URL("../package.json", import.meta.url),
): string {
  try {
    return (
      parsePackageVersion(readFileSync(manifestUrl, "utf8")) ??
      UNKNOWN_PACKAGE_VERSION
    );
  } catch {
    return UNKNOWN_PACKAGE_VERSION;
  }
}

export const PACKAGE_VERSION = readPackageVersion();

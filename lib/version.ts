// Single source of truth for the package version reported to providers.
// Read from package.json at runtime so there is nothing to keep in sync by
// hand and no build step is required.
import { readFileSync } from "node:fs";
import { isRecord } from "./types.js";

function readPackageVersion(): string {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (!isRecord(raw) || typeof raw.version !== "string" || !raw.version) {
    throw new Error("pi-web-search: package.json is missing a version");
  }
  return raw.version;
}

export const PACKAGE_VERSION = readPackageVersion();

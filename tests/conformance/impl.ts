// Loads the implementation under test. Defaults to this repo's entry point;
// override with PI_WEB_SEARCH_IMPL to validate a reimplementation:
//
//   PI_WEB_SEARCH_IMPL=/path/to/other/index.ts npm run conformance
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadImpl(): Promise<Record<string, any>> {
  const target = process.env.PI_WEB_SEARCH_IMPL;
  const url = target
    ? pathToFileURL(resolve(process.cwd(), target)).href
    : new URL("../../index.js", import.meta.url).href;
  return import(url);
}

export async function readFixture(...parts: string[]): Promise<string> {
  return readFile(
    new URL(`../fixtures/${parts.join("/")}`, import.meta.url),
    "utf8",
  );
}

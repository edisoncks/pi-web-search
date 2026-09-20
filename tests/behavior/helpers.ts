import { readFile } from "node:fs/promises";

/** Read a fixture from tests/fixtures by path segments. */
export async function readFixture(...parts: string[]): Promise<string> {
  return readFile(
    new URL(`../fixtures/${parts.join("/")}`, import.meta.url),
    "utf8",
  );
}

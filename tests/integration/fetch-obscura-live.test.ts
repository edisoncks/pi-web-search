import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPageForTool } from "../../lib/fetch.js";
import { createFetchState } from "../../lib/policy.js";

// A real `obscura` subprocess on PATH drives the page-fetch path end to end:
// spawn, extract, and shape the per-URL outcome. The stub prints a chosen
// fixture, so success and failure are exercised without the network.

const posixDescribe = process.platform === "win32" ? describe.skip : describe;

function fixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/fetch/${name}`, import.meta.url));
}

const savedPath = process.env.PATH;
const savedPageFile = process.env.FAKE_OBSCURA_PAGE_FILE;
const savedFail = process.env.FAKE_OBSCURA_FAIL;
let binDir = "";

before(async () => {
  binDir = await mkdtemp(join(tmpdir(), "pi-web-search-fetch-"));
  const script = [
    "#!/usr/bin/env node",
    'const { readFileSync } = require("node:fs");',
    'if (process.env.FAKE_OBSCURA_FAIL === "1") process.exit(1);',
    "process.stdout.write(",
    '  readFileSync(process.env.FAKE_OBSCURA_PAGE_FILE, "utf8"),',
    ");",
    "",
  ].join("\n");
  await writeFile(join(binDir, "obscura"), script, "utf8");
  await chmod(join(binDir, "obscura"), 0o755);
  process.env.PATH = `${binDir}:${savedPath ?? ""}`;
});

after(async () => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  if (savedPageFile === undefined) delete process.env.FAKE_OBSCURA_PAGE_FILE;
  else process.env.FAKE_OBSCURA_PAGE_FILE = savedPageFile;
  if (savedFail === undefined) delete process.env.FAKE_OBSCURA_FAIL;
  else process.env.FAKE_OBSCURA_FAIL = savedFail;
  if (binDir) await rm(binDir, { recursive: true, force: true });
});

posixDescribe("page fetch subprocess boundary (real obscura on PATH)", () => {
  it("fetches a page and formats its content", async () => {
    process.env.FAKE_OBSCURA_PAGE_FILE = fixture("page.md");
    const result = await fetchPageForTool(
      { url: "https://example.com/hello" },
      createFetchState(),
      undefined,
    );
    assert.equal(result.resultCount, 1);
    assert.match(result.text, /https:\/\/example\.com\/hello/);
    assert.match(result.text, /synthetic fixture page/);
  });

  it("reports a failed page without throwing", async () => {
    process.env.FAKE_OBSCURA_PAGE_FILE = fixture("page.md");
    process.env.FAKE_OBSCURA_FAIL = "1";
    const result = await fetchPageForTool(
      { url: "https://example.com/boom" },
      createFetchState(),
      undefined,
    );
    assert.equal(result.resultCount, 0);
    assert.match(result.text, /Error:/);
  });

  it("rejects a missing obscura with a PATH hint", async () => {
    const original = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      await assert.rejects(
        fetchPageForTool(
          { url: "https://example.com/x" },
          createFetchState(),
          undefined,
        ),
        /obscura not found on PATH/,
      );
    } finally {
      process.env.PATH = original;
    }
  });
});

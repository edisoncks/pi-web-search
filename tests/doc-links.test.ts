import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

async function markdownFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(repoRoot)) {
    if (entry.endsWith(".md")) files.push(resolve(repoRoot, entry));
  }
  for (const dir of ["docs", "tests/fixtures"]) {
    try {
      for (const entry of await readdir(resolve(repoRoot, dir))) {
        if (entry.endsWith(".md")) files.push(resolve(repoRoot, dir, entry));
      }
    } catch {
      // Directory may not exist; nothing to check.
    }
  }
  return files;
}

function relativeLinks(markdown: string): string[] {
  const links: string[] = [];
  const pattern = /\[[^\]]*\]\(([^)]+)\)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const target = match[1].trim().replace(/#.*$/u, "");
    if (!target) continue;
    if (/^(https?:|mailto:|#)/iu.test(target)) continue;
    links.push(target);
  }
  return links;
}

const files = await markdownFiles();

describe("documentation relative links resolve", () => {
  assert.ok(files.length > 0, "expected to find markdown docs");

  for (const file of files) {
    it(`${file.slice(repoRoot.length)} has no dead relative links`, async () => {
      const markdown = await readFile(file, "utf8");
      for (const target of relativeLinks(markdown)) {
        const resolved = resolve(dirname(file), target);
        await assert.doesNotReject(
          access(resolved),
          `dead link '${target}' in ${file.slice(repoRoot.length)}`,
        );
      }
    });
  }
});

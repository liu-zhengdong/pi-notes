import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { KeywordStore } from "../src/keyword-store.ts";
import { NotesLoader } from "../src/notes.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const artifact = join(repo, ".artifacts", `store-${Date.now()}`);
const raw = join(artifact, "raw");
const work = join(artifact, "work");
const cache = join(work, "cache");
await mkdir(raw, { recursive: true });
await mkdir(work, { recursive: true });
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      (
        await readdir(join(repo, "src"))
      ).map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(join(repo, "src", name)))
          .digest("hex"),
      ]),
    ),
  );
const before = await hashes();
await writeFile(
  join(raw, "source-hashes.json"),
  JSON.stringify(before, null, 2),
);
const root = process.argv[2] ? resolve(process.argv[2]) : join(work, "vault");
if (!process.argv[2]) {
  await mkdir(join(root, "deep"), { recursive: true });
  for (let i = 0; i < 10000; i++)
    await writeFile(
      join(root, "deep", `${i}.md`),
      i % 4
        ? "ordinary note"
        : `---\nkeywords: [key-${i}]\ndescription: hint-${i}\n---\nBody stays private.\n`,
    );
}
const config = { directory: root, maxContextBytes: 262144 };
const loader = new NotesLoader();
const rows = [];
for (const phase of ["cold", "restarted-with-disk-cache"]) {
  const store = new KeywordStore(cache);
  try {
    const snapshot = await loader.scan(config);
    let t = performance.now();
    store.prepare(snapshot);
    const prepareMs = performance.now() - t;
    await store.publish();
    const readyMs = performance.now() - t;
    const loaded = store.stats;
    const map = store.index.notes;
    const submits = [];
    for (let n = 0; n < 5; n++) {
      t = performance.now();
      store.prepare(await loader.scan(config));
      const beforeAgentMs = performance.now() - t;
      await store.publish();
      submits.push({ beforeAgentMs, throughContextMs: performance.now() - t });
      assert.equal(store.index.notes, map);
      assert.equal(store.stats.refreshes, loaded.refreshes);
    }
    if (phase !== "cold") assert.equal(loaded.reads, 0);
    rows.push({
      phase,
      prepareMs,
      readyMs,
      stats: loaded,
      notes: store.index.notes.size,
      issues: store.index.issues,
      submits,
    });
  } finally {
    await store.close();
  }
}
assert.deepEqual(await hashes(), before);
await writeFile(
  join(raw, "results.json"),
  JSON.stringify(
    { root, node: process.version, rows, rssBytes: process.memoryUsage().rss },
    null,
    2,
  ),
);
console.log(JSON.stringify(rows, null, 2));
console.log(`Evidence: ${artifact}`);

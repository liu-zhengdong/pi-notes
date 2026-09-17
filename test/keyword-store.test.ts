import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { KeywordStore } from "../src/keyword-store.ts";
import { KeywordIndex } from "../src/keywords.ts";
import { NotesLoader } from "../src/notes.ts";

const note = (key: string) =>
  `---\nkeywords: [${key}]\ndescription: SUMMARY_${key}\n---\nPRIVATE_BODY`;
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "notes-store-"));
  const root = join(dir, "vault");
  const deep = join(root, "deep");
  const cache = join(dir, "cache");
  await mkdir(deep, { recursive: true });
  await writeFile(join(root, "root.md"), "---\ndefaultopen: true\n---\nROOT");
  await writeFile(join(deep, "target.md"), note("old-key"));
  const stores: KeywordStore[] = [];
  const create = () => {
    const s = new KeywordStore(cache);
    stores.push(s);
    return s;
  };
  const snapshot = () =>
    new NotesLoader().scan({ directory: root, maxContextBytes: 262144 });
  t.after(async () => {
    for (const s of stores) await s.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, root, deep, cache, create, snapshot };
}

test("background preparation, unchanged sends reuse exact published map, persisted headers survive restart", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 128; i++)
    await writeFile(join(f.deep, `${i}.md`), "plain");
  const current = await f.snapshot();
  const first = f.create();
  first.prepare(current);
  assert.equal(
    first.pending,
    true,
    "prepare returns before recursive scan completes",
  );
  await first.publish();
  assert.equal(first.stats.reads, 129);
  assert.equal(first.index.match("old-key").length, 1);
  const view = first.index.notes;
  for (let i = 0; i < 4; i++) {
    first.prepare(await f.snapshot());
    await first.publish();
  }
  assert.equal(
    first.stats.refreshes,
    1,
    "no whole-library work on unchanged sends",
  );
  assert.equal(first.index.notes, view, "do not rebuild even the match map");
  await first.close();
  const paths = await readdir(f.cache);
  assert.equal(paths.length, 1);
  const path = join(f.cache, paths[0]);
  const saved = await readFile(path, "utf8");
  assert.ok(!saved.includes("PRIVATE_BODY"));
  if (process.platform !== "win32")
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  const before = await stat(path, { bigint: true });
  const second = f.create();
  second.prepare(current);
  await second.publish();
  assert.equal(second.stats.reads, 0);
  assert.equal(second.stats.cacheHits, 129);
  assert.equal(second.index.match("old-key").length, 1);
  await second.close();
  assert.equal(
    (await stat(path, { bigint: true })).mtimeNs,
    before.mtimeNs,
    "unchanged restart does not rewrite cache",
  );
});

test("watcher incrementally handles edit, create, rename, delete, bad metadata and directory symlinks", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 128; i++)
    await writeFile(join(f.deep, `${i}.md`), "plain");
  const store = f.create();
  store.prepare(await f.snapshot());
  await store.publish();
  const target = join(f.deep, "target.md");
  await writeFile(target, note("new-key"));
  await delay(100);
  await store.publish();
  assert.equal(store.index.match("old-key").length, 0);
  assert.deepEqual(store.index.match("new-key"), [target]);
  assert.ok(
    store.stats.reads <= 1 && store.stats.cacheHits < 4,
    JSON.stringify(store.stats),
  );
  await mkdir(join(f.root, "created"));
  const added = join(f.root, "created", "added.md");
  await writeFile(added, note("added-key"));
  await delay(100);
  await store.publish();
  assert.deepEqual(store.index.match("added-key"), [added]);
  const moved = join(f.root, "created", "renamed.md");
  await rename(added, moved);
  await delay(100);
  await store.publish();
  assert.deepEqual(store.index.match("added-key"), [moved]);
  await writeFile(target, "---\nkeywords: false\n---\nSECRET");
  await delay(100);
  await store.publish();
  assert.deepEqual(store.index.match("new-key"), []);
  assert.match(store.index.issues.join("\n"), /keywords/);
  await rm(join(f.root, "created"), { recursive: true });
  await mkdir(join(f.dir, "outside"));
  await writeFile(join(f.dir, "outside", "leak.md"), note("leak"));
  await symlink(join(f.dir, "outside"), join(f.root, "created"));
  await delay(100);
  await store.publish();
  assert.deepEqual(store.index.match("added-key leak"), []);
  await writeFile(target, note("repaired"));
  await delay(100);
  await store.publish();
  assert.deepEqual(store.index.match("repaired"), [target]);
});

test("offline changes invalidate disk metadata; a disabled or untrusted source never publishes old entries", async (t) => {
  const f = await fixture(t);
  const first = f.create();
  const initial = await f.snapshot();
  first.prepare(initial);
  await first.publish();
  await first.close();
  await writeFile(join(f.deep, "target.md"), note("offline-key"));
  const second = f.create();
  second.prepare(initial);
  await second.publish();
  assert.deepEqual(second.index.match("old-key"), []);
  assert.equal(second.stats.reads, 1);
  assert.equal(second.index.match("offline-key").length, 1);
  second.prepare({
    ...initial,
    sources: initial.sources.map((source) => ({
      ...source,
      text: "",
      skipped: "untrusted",
    })),
  });
  await second.publish();
  assert.equal(second.index.notes.size, 0);
  second.reset();
  await second.publish();
  assert.equal(second.index.notes.size, 0);
});

test("corrupt and forged disk caches are rejected; disk failure never breaks the live index", async (t) => {
  const f = await fixture(t);
  const first = f.create();
  const initial = await f.snapshot();
  first.prepare(initial);
  await first.publish();
  await first.close();
  const path = join(
    f.cache,
    createHash("sha256").update(f.root).digest("hex") + ".json",
  );
  const valid = JSON.parse(await readFile(path, "utf8"));
  const cases = [
    "{broken",
    JSON.stringify({ ...valid, version: 999 }),
    JSON.stringify({ ...valid, root: f.dir }),
    JSON.stringify({
      ...valid,
      entries: [{ ...valid.entries[0], path: join(f.dir, "outside.md") }],
    }),
    JSON.stringify({
      ...valid,
      entries: valid.entries.map((entry: { note: object }) => ({
        ...entry,
        note: { ...entry.note, body: "FORGED_BODY" },
      })),
    }),
  ];
  for (const data of cases) {
    await writeFile(path, data);
    const store = f.create();
    store.prepare(initial);
    await store.publish();
    assert.equal(store.stats.reads, 1);
    assert.equal(store.index.match("old-key").length, 1);
    assert.match(store.index.issues.join("\n"), /缓存不可用/);
    assert.ok(!JSON.stringify([...store.index.notes]).includes("FORGED_BODY"));
    await store.close();
  }
  await rm(path);
  const external = join(f.dir, "external.json");
  await writeFile(external, "do not overwrite");
  await symlink(external, path);
  const linked = f.create();
  linked.prepare(initial);
  await linked.publish();
  assert.match(linked.index.issues.join("\n"), /缓存不可用/);
  await linked.close();
  assert.equal(await readFile(external, "utf8"), "do not overwrite");
});

test("root replacement and folders named .md invalidate only the affected source", async (t) => {
  const f = await fixture(t);
  const store = f.create();
  store.prepare(await f.snapshot());
  await store.publish();
  await rename(f.root, join(f.dir, "old-vault"));
  await mkdir(f.deep, { recursive: true });
  await writeFile(join(f.deep, "replacement.md"), note("replacement"));
  store.prepare(await f.snapshot());
  await store.publish();
  assert.equal(store.index.match("old-key").length, 0);
  assert.equal(store.index.match("replacement").length, 1);
  await mkdir(join(f.root, "folder.md"));
  await writeFile(join(f.root, "folder.md", "inside.md"), note("inside"));
  await delay(100);
  await store.publish();
  assert.equal(store.index.match("inside").length, 1);
});

test("unwritable disk cache degrades to working in-memory indexing", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip();
  const f = await fixture(t);
  await mkdir(f.cache, { mode: 0o500 });
  const store = f.create();
  try {
    store.prepare(await f.snapshot());
    await store.publish();
    assert.equal(store.index.match("old-key").length, 1);
    await store.close();
    store.prepare(await f.snapshot());
    await store.publish();
    assert.equal(store.index.match("old-key").length, 1);
    assert.match(store.index.issues.join("\n"), /缓存未保存/);
  } finally {
    await chmod(f.cache, 0o700);
  }
});

test("watch and indexing errors coexist, recover independently and disappear after repair", async (t) => {
  const f = await fixture(t);
  const initial = await f.snapshot();
  const store = f.create();
  const moved = join(f.dir, "temporarily-missing");
  await rename(f.root, moved);
  // A missing root does not synchronously fail recursive watch on every OS.
  const failedWatch = t.mock.method(fs, "watch", () => {
    throw new Error("injected watcher failure");
  });
  syncBuiltinESMExports();
  try {
    store.prepare(initial);
    await store.publish();
  } finally {
    failedWatch.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(store.index.notes.size, 0);
  assert.match(store.index.issues.join("\n"), /文件监听不可用/);
  assert.match(store.index.issues.join("\n"), /索引失败/);
  t.diagnostic(JSON.stringify({ stage: "watch-and-index-failed", issues: store.index.issues }));
  await store.close();

  await rename(moved, f.root);
  const failedIndex = t.mock.method(KeywordIndex.prototype, "refresh", async () => {
    throw new Error("injected indexing failure after watcher recovery");
  });
  try {
    store.prepare(initial);
    await store.publish();
    assert.doesNotMatch(store.index.issues.join("\n"), /文件监听不可用/);
    assert.match(store.index.issues.join("\n"), /injected indexing failure/);
    t.diagnostic(JSON.stringify({ stage: "watch-recovered", issues: store.index.issues }));
    assert.equal(store.index.notes.size, 0);
    await store.close();
  } finally {
    failedIndex.mock.restore();
  }

  store.prepare(initial);
  await store.publish();
  assert.equal(store.index.match("old-key").length, 1);
  assert.deepEqual(store.index.issues, []);
  t.diagnostic(JSON.stringify({ stage: "index-recovered", issues: store.index.issues }));
});

test("cache read and write errors survive successful indexing until the disk cache is repaired", async (t) => {
  const f = await fixture(t);
  const initial = await f.snapshot();
  const path = join(f.cache, createHash("sha256").update(f.root).digest("hex") + ".json");
  await mkdir(f.cache);
  await writeFile(path, "{corrupt");
  const store = f.create();
  store.prepare(initial);
  await store.publish();
  assert.equal(store.index.match("old-key").length, 1);
  assert.match(store.index.issues.join("\n"), /缓存不可用/);

  // Make persistence fail on every platform without depending on chmod/root.
  await rm(f.cache, { recursive: true });
  await writeFile(f.cache, "not a directory");
  await delay(1100); // Let background persistence fail; native watchers may emit duplicates.
  await store.publish();
  assert.match(store.index.issues.join("\n"), /缓存不可用/);
  assert.match(store.index.issues.join("\n"), /缓存未保存/);
  assert.equal(store.index.issues.length, 2);
  await store.close();

  store.prepare(initial);
  await store.publish();
  assert.equal(store.index.match("old-key").length, 1);
  assert.equal(store.index.issues.length, 2, "a good refresh must not clear disk failures");
  t.diagnostic(JSON.stringify({ stage: "cache-read-and-write-failed", issues: store.index.issues }));
  await rm(f.cache);
  await store.close(); // Successful atomic replacement repairs the rejected cache.
  const repaired = JSON.parse(await readFile(path, "utf8"));
  assert.equal(repaired.version, 1);
  assert.equal(repaired.root, f.root);
  assert.ok(!JSON.stringify(repaired).includes("PRIVATE_BODY"));
  store.prepare(initial);
  await store.publish();
  assert.deepEqual(store.index.issues, []);
  assert.equal(store.index.match("old-key").length, 1);
  t.diagnostic(JSON.stringify({ stage: "cache-repaired", issues: store.index.issues }));
});

test("already-persisted content clears a save failure without rewriting the cache", async (t) => {
  const f = await fixture(t);
  const initial = await f.snapshot();
  const store = f.create();
  store.prepare(initial);
  await store.publish();
  await store.close();
  const path = join(f.cache, (await readdir(f.cache))[0]);
  const before = await stat(path, { bigint: true });
  const failedSave = t.mock.method(KeywordIndex.prototype, "exportCache", () => {
    throw new Error("injected serialization failure");
  });
  try {
    await store.close();
  } finally {
    failedSave.mock.restore();
  }
  store.prepare(initial);
  await store.publish();
  assert.match(store.index.issues.join("\n"), /injected serialization failure/);
  await store.close();
  store.prepare(initial);
  await store.publish();
  assert.deepEqual(store.index.issues, []);
  assert.equal((await stat(path, { bigint: true })).mtimeNs, before.mtimeNs);
});

test("cache validator rejects bodies, hidden paths, relative paths and invalid keyword types atomically", () => {
  const index = new KeywordIndex();
  const root = "/vault";
  const path = "/vault/deep/note.md";
  const valid = {
    path,
    signature: "1:2:3:4:5",
    note: { path, name: "note.md", keywords: ["key"] },
  };
  for (const data of [
    {},
    [{ ...valid, path: "relative.md" }],
    [{ ...valid, path: "/vault/.hidden/note.md" }],
    [{ ...valid, note: { ...valid.note, body: "secret" } }],
    [{ ...valid, note: { ...valid.note, keywords: [1] } }],
    [{ ...valid, note: { ...valid.note, keywords: [" KEY "] } }],
  ])
    assert.throws(() => index.importCache(data, root), /缓存/);
  index.importCache([valid], root);
  assert.equal(
    index.notes.size,
    0,
    "loaded cache cannot match before disk signatures are verified",
  );
});

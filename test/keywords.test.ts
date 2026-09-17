import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KeywordIndex } from "../src/keywords.ts";
import { DEFAULT_MAX_CONTEXT_BYTES } from "../src/config.ts";
import {
  discoverNoteDirectories,
  NotesLoader,
  parseMetadata,
  resolveSources,
} from "../src/notes.ts";

for (const invalid of [
  "word",
  "null",
  "123",
  "[ok, 1]",
  "['']",
  "['  ']",
  "{x: y}",
  "[true]",
]) {
  test(`reject keyword value ${invalid}`, () =>
    assert.throws(() => parseMetadata(`keywords: ${invalid}`), /keywords/));
}
test("keywords are trimmed, literal, case insensitive and deduplicated", () => {
  assert.deepEqual(
    parseMetadata("keywords: [' Font-family ', FONT-FAMILY, 字体, '[regex].*']")
      .keywords,
    ["font-family", "字体", "[regex].*"],
  );
  assert.deepEqual(parseMetadata("keywords: []").keywords, []);
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "notes-keywords-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const deep = join(directory, "vault", "a", "b");
  await mkdir(deep, { recursive: true });
  const config = {
    directory: join(directory, "vault"),
    maxContextBytes: DEFAULT_MAX_CONTEXT_BYTES,
  };
  const loader = new NotesLoader();
  const index = new KeywordIndex();
  return {
    directory,
    deep,
    config,
    index,
    refresh: async () => index.refresh(await loader.scan(config)),
  };
}

test("recursive summaries only, root dedup, hidden/symlink/bad metadata excluded", async (t) => {
  const { directory, deep, config, index, refresh } = await fixture(t);
  const note =
    "---\nkeywords: [字体, 'font-family', '[regex].*']\ndefaultopen: true\ndescription: FONT_GUIDANCE\npurpose: SETTING_FONTS\n---\n";
  await writeFile(join(config.directory, "root.md"), note + "ROOT_BODY");
  await writeFile(join(deep, "fonts.md"), note + "PRIVATE_BODY".repeat(100000));
  await writeFile(join(deep, ".hidden.md"), note);
  await mkdir(join(deep, ".hidden"));
  await writeFile(join(deep, ".hidden", "note.md"), note);
  await writeFile(
    join(deep, "bad.md"),
    "---\nkeywords: [' ']\n---\nPRIVATE_BAD",
  );
  await symlink(join(deep, "fonts.md"), join(deep, "link.md"));
  await mkdir(join(directory, "outside"));
  await writeFile(join(directory, "outside", "external.md"), note);
  await symlink(join(directory, "outside"), join(deep, "outside"));
  await refresh();
  assert.equal(index.notes.size, 1);
  assert.equal(index.notes.get(join(deep, "fonts.md"))?.body, undefined);
  assert.equal(
    index.notes.get(join(deep, "fonts.md"))?.description,
    "FONT_GUIDANCE",
  );
  assert.deepEqual(index.match("use FONT-FAMILY"), [join(deep, "fonts.md")]);
  assert.deepEqual(index.match("字体 字体"), [join(deep, "fonts.md")]);
  assert.deepEqual(index.match("regex"), []);
  assert.deepEqual(index.match("[regex].*"), [join(deep, "fonts.md")]);
  assert.ok(index.issues.some((issue) => issue.includes("bad.md")));
});

test("cache includes non-keyword files; edits, deletion, new files and removed sources refresh", async (t) => {
  const { deep, index, refresh } = await fixture(t);
  const path = join(deep, "note.md");
  await writeFile(path, "plain text");
  await refresh();
  assert.equal(index.reads, 1);
  await refresh();
  assert.equal(index.reads, 0);
  assert.equal(index.cacheHits, 1);
  await writeFile(path, "---\nkeywords: [changed]\n---\n");
  await refresh();
  assert.deepEqual(index.match("changed"), [path]);
  assert.equal(index.reads, 1);
  await writeFile(join(deep, "new.md"), "---\nkeywords: [new]\n---\n");
  await rm(path);
  await refresh();
  assert.deepEqual(index.match("changed"), []);
  assert.equal(index.notes.size, 1);
  await index.refresh({
    directory: null,
    sources: [],
    text: "",
    bytes: 0,
    issues: [],
    reads: 0,
    cacheHits: 0,
  });
  assert.deepEqual(index.match("new"), []);
});

test("project .note deep entries are indexed only from trusted selected sources, including inside a global ancestor", async (t) => {
  const { directory, config, index } = await fixture(t);
  const project = join(config.directory, "project");
  const noteDir = join(project, ".note");
  await mkdir(join(noteDir, "deep"), { recursive: true });
  await mkdir(join(project, ".git"));
  const path = join(noteDir, "deep", "project.md");
  await writeFile(path, "---\nkeywords: [project-key]\n---\nNOT_AUTOREAD");
  const discovery = await discoverNoteDirectories(project);
  assert.deepEqual(discovery.paths, [noteDir]);
  for (const trusted of [false, true]) {
    const snapshot = await new NotesLoader().scan(
      config,
      resolveSources(config, discovery, () => trusted),
    );
    await index.refresh(snapshot);
    assert.deepEqual(index.match("project-key"), trusted ? [path] : []);
  }
  assert.equal(index.notes.size, 1);
  assert.ok(!directory.endsWith(".note"));
});

test("malformed metadata is cached, diagnostics are bounded, repairs refresh", async (t) => {
  const { deep, index, refresh } = await fixture(t);
  for (let i = 0; i < 110; i++)
    await writeFile(join(deep, `${i}.md`), "---\nkeywords: false\n---\n");
  await refresh();
  assert.equal(index.notes.size, 0);
  assert.equal(index.reads, 110);
  assert.equal(index.issues.length, 101);
  assert.match(index.issues.at(-1)!, /另有 10 项/);
  await refresh();
  assert.equal(index.reads, 0);
  assert.equal(index.cacheHits, 110);
  await writeFile(
    join(deep, "0.md"),
    "---\nkeywords: [fixed]\n? [unrelated, complex, key]\n: allowed\n---\n",
  );
  await refresh();
  assert.deepEqual(index.match("fixed"), [join(deep, "0.md")]);
  assert.equal(index.reads, 1);
});

test("permission errors are excluded and reported; repair recovers", async (t) => {
  if (process.getuid?.() === 0 || process.platform === "win32") return t.skip();
  const { deep, index, refresh } = await fixture(t);
  const path = join(deep, "private.md");
  await writeFile(path, "---\nkeywords: [secret]\n---\n");
  await chmod(path, 0);
  try {
    await refresh();
    assert.deepEqual(index.match("secret"), []);
    assert.match(index.issues.join("\n"), /EACCES/);
  } finally {
    await chmod(path, 0o600);
  }
  await refresh();
  assert.deepEqual(index.match("secret"), [path]);
});

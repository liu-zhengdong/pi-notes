import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_MAX_CONTEXT_BYTES,
  defaultNotesDirectory,
  loadConfig,
  saveDirectory,
  validateDirectory,
} from "../src/config.ts";
import {
  discoverNoteDirectories,
  headerBounds,
  MAX_HEADER_BYTES,
  NotesLoader,
  parseMetadata,
  previewSnapshot,
  resolveSources,
  UNTRUSTED_REASON,
} from "../src/notes.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "pi-notes-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    config: { directory, maxContextBytes: DEFAULT_MAX_CONTEXT_BYTES },
    loader: new NotesLoader(),
  };
}

for (const [name, yaml] of Object.entries({
  "quoted false": 'defaultopen: "false"',
  "quoted true": 'defaultopen: "true"',
  "numeric boolean": "defaultopen: 1",
  "duplicate key": "defaultopen: false\ndefaultopen: true",
  "description list": "description: [text]",
  "purpose map": "purpose: { x: y }",
  "top-level scalar": "true",
  "top-level list": "- true",
  "bad YAML": "description: [",
  "unknown tag": "purpose: !secret value",
  "YAML alias": "description: &x text\npurpose: *x",
})) {
  test(`rejects ${name}`, () => {
    assert.throws(() => parseMetadata(yaml));
  });
}

test("valid frontmatter, folded text and unrelated Obsidian properties", () => {
  assert.deepEqual(
    parseMetadata(
      "description: 简介\npurpose: >-\n  第一行\n  第二行\ndefaultopen: true\ntags: [a, b]\naliases: [用户]",
    ),
    {
      defaultopen: true,
      description: "简介",
      purpose: "第一行 第二行",
    },
  );
  assert.deepEqual(parseMetadata(""), { defaultopen: false });
  assert.deepEqual(parseMetadata("description:\npurpose: ''"), {
    defaultopen: false,
  });
  assert.deepEqual(parseMetadata("__proto__: { defaultopen: true }"), {
    defaultopen: false,
  });
});

test("BOM/CRLF, no frontmatter, delimiter at EOF and incomplete prefixes", () => {
  assert.equal(headerBounds("# 标题\n---\n正文", true)?.bodyOffset, 0);
  const text = "\uFEFF---\r\ndefaultopen: true\r\n---\r\n完整正文\r\n";
  assert.equal(
    text.slice(headerBounds(text, true)!.bodyOffset),
    "完整正文\r\n",
  );
  assert.ok(headerBounds("---\n---", true));
  assert.equal(headerBounds("---\ndescription: x\n---", false), undefined);
  assert.throws(
    () => headerBounds("---\ndefaultopen: true\n正文", true),
    /缺少结束/,
  );
});

test("only root notes and folders; purpose in both modes; body preserved exactly", async (t) => {
  const { directory, config, loader } = await fixture(t);
  const body = "\n# 偏好\n\n保留 [[双链]]、空行和尾部空格。  \n";
  await writeFile(
    join(directory, "USER.md"),
    `---\npurpose: 用户建模\ndefaultopen: true\n---\n${body}`,
  );
  await writeFile(
    join(directory, "参考.md"),
    "---\ndescription: 摘要\npurpose: 背景资料\ndefaultopen: false\n---\nMUST_NOT_AUTO_INJECT",
  );
  await writeFile(join(directory, "无属性.md"), "ALSO_NOT_INJECTED");
  await mkdir(join(directory, "项目", "深层"), { recursive: true });
  await writeFile(
    join(directory, "项目", "深层", "nested.md"),
    "---\ndefaultopen: true\n---\nNESTED_SECRET",
  );
  await mkdir(join(directory, ".obsidian"));
  await writeFile(
    join(directory, ".hidden.md"),
    "---\ndefaultopen: true\n---\nHIDDEN",
  );
  await writeFile(join(directory, "附件.txt"), "ATTACHMENT");
  await symlink(join(directory, "USER.md"), join(directory, "link.md"));
  const result = await loader.scan(config);
  assert.equal(result.sources.length, 1);
  const source = result.sources[0];
  assert.equal(source.notes.length, 3);
  assert.equal(source.folders.length, 1);
  assert.ok(!source.skipped);
  assert.equal(source.notes.find((n) => n.name === "USER.md")?.body, body);
  for (const marker of [
    "用户建模",
    "背景资料",
    "摘要",
    body,
    join(directory, "项目"),
  ])
    assert.ok(result.text.includes(marker));
  for (const marker of [
    "MUST_NOT_AUTO_INJECT",
    "ALSO_NOT_INJECTED",
    "NESTED_SECRET",
    ".obsidian",
    "link.md",
    "附件.txt",
    "defaultopen:",
  ])
    assert.ok(!result.text.includes(marker), marker);
  assert.equal(result.bytes, Buffer.byteLength(result.text));
  assert.equal(result.issues.length, 0);
});

test("cache refreshes edits, atomic replacement, creation, deletion and directory changes", async (t) => {
  const { directory, config, loader } = await fixture(t);
  const path = join(directory, "a.md");
  const note = (body: string) => `---\ndefaultopen: true\n---\n${body}`;
  await writeFile(path, note("old"));
  assert.equal((await loader.scan(config)).reads, 1);
  const stable = await loader.scan(config);
  assert.equal(stable.reads, 0);
  assert.equal(stable.cacheHits, 1);
  await writeFile(path, note("new"));
  assert.ok((await loader.scan(config)).text.includes("new"));
  await writeFile(join(directory, "swap"), note("renamed"));
  await rename(join(directory, "swap"), path);
  assert.ok((await loader.scan(config)).text.includes("renamed"));
  await writeFile(join(directory, "b.md"), "new entry");
  assert.equal((await loader.scan(config)).sources[0].notes.length, 2);
  await unlink(path);
  assert.ok(!(await loader.scan(config)).text.includes("renamed"));
  const next = join(directory, "other");
  await mkdir(next);
  assert.equal(
    (
      await loader.scan({ ...config, directory: next }, [
        { kind: "project", path: next },
      ])
    ).sources[0].notes.length,
    0,
  );
  assert.equal((await loader.scan(config)).reads, 1);
});

test("malformed and oversized notes keep paths, never partial or stale full text", async (t) => {
  const { directory, config, loader } = await fixture(t);
  const path = join(directory, "bad.md");
  await writeFile(path, "---\ndefaultopen: true\n---\nOLD_FULL");
  await loader.scan(config);
  await writeFile(path, '---\ndefaultopen: "false"\n---\nPRIVATE_BODY');
  let result = await loader.scan(config);
  assert.equal(result.issues.length, 1);
  assert.ok(result.text.includes(path));
  assert.ok(
    !result.text.includes("PRIVATE_BODY") && !result.text.includes("OLD_FULL"),
  );
  await writeFile(
    path,
    `---\ndefaultopen: true\n---\n${"x".repeat(DEFAULT_MAX_CONTEXT_BYTES + 1)}`,
  );
  result = await loader.scan(config);
  assert.equal(result.sources[0].notes[0].body, undefined);
  assert.match(result.sources[0].notes[0].error!, /文件超过/);
  await writeFile(
    path,
    `---\ndescription: ${"x".repeat(MAX_HEADER_BYTES)}\n---\nHEADER_SECRET`,
  );
  result = await loader.scan(config);
  assert.match(result.sources[0].notes[0].error!, /frontmatter 超过/);
  assert.ok(!result.text.includes("HEADER_SECRET"));
});

test("large summary-mode body does not enter memory/context as a full note", async (t) => {
  const { directory, config, loader } = await fixture(t);
  await writeFile(
    join(directory, "large.md"),
    `---\ndescription: LARGE_SUMMARY\ndefaultopen: false\n---\n${"body".repeat(1024 * 1024)}`,
  );
  const result = await loader.scan(config);
  assert.equal(result.issues.length, 0);
  assert.ok(result.bytes < 1024);
  assert.ok(result.text.includes("LARGE_SUMMARY"));
  assert.equal(result.sources[0].notes[0].body, undefined);
});

test("context budget accepts its exact UTF-8 boundary and rejects one byte less", async (t) => {
  const { directory, config, loader } = await fixture(t);
  await writeFile(
    join(directory, "a.md"),
    `---\ndefaultopen: true\n---\n${"字".repeat(400)}`,
  );
  await writeFile(
    join(directory, "b.md"),
    "---\ndescription: 摘要\n---\nunused",
  );
  await mkdir(join(directory, "folder"));
  const size = (await loader.scan(config)).bytes;
  assert.equal(
    (await loader.scan({ ...config, maxContextBytes: size })).bytes,
    size,
  );
  // Budget overflow now excludes the whole source instead of throwing.
  const excluded = await loader.scan({ ...config, maxContextBytes: size - 1 });
  assert.equal(excluded.text, "");
  assert.equal(excluded.sources[0].notes.length, 0);
  assert.match(excluded.sources[0].skipped!, /未注入/);
  assert.match(excluded.issues[0], /未注入/);
});

test("rejects aggregate budget overflow rather than labelling truncated text as full", async (t) => {
  const { directory, config, loader } = await fixture(t);
  for (const name of ["a.md", "b.md", "c.md"])
    await writeFile(
      join(directory, name),
      `---\ndefaultopen: true\n---\n${"中".repeat(180)}`,
    );
  // Whole sources exceeding the budget are excluded and reported, never truncated.
  const excluded = await loader.scan({ ...config, maxContextBytes: 1024 });
  assert.equal(excluded.text, "");
  assert.match(excluded.sources[0].skipped!, /未注入/);
});

test("unreadable files and directories are reported, recover after repair", async (t) => {
  if (process.getuid?.() === 0 || process.platform === "win32")
    return t.skip("requires POSIX non-root permissions");
  const { directory, config, loader } = await fixture(t);
  const path = join(directory, "private.md");
  await writeFile(path, "---\ndefaultopen: true\n---\nPRIVATE");
  await chmod(path, 0);
  const result = await loader.scan(config);
  assert.equal(result.sources[0].notes[0].body, undefined);
  assert.match(result.sources[0].notes[0].error!, /EACCES/);
  await chmod(path, 0o600);
  assert.ok((await loader.scan(config)).text.includes("PRIVATE"));
  await chmod(directory, 0);
  try {
    const blocked = await loader.scan(config);
    assert.equal(blocked.text, "");
    assert.match(blocked.sources[0].skipped!, /EACCES/);
    assert.match(blocked.issues[0], /EACCES/);
  } finally {
    await chmod(directory, 0o700);
  }
});

test("discoverNoteDirectories walks shallow to deep and stops at the git root", async (t) => {
  const { directory } = await fixture(t);
  const nested = join(directory, "a", "b");
  await mkdir(join(nested), { recursive: true });
  await mkdir(join(directory, ".note"));
  await mkdir(join(directory, "a", ".note"));
  await mkdir(join(nested, ".note"));
  await mkdir(join(directory, "a", ".git"));
  const fromLeaf = await discoverNoteDirectories(nested);
  assert.deepEqual(fromLeaf.paths, [
    join(directory, "a", ".note"),
    join(nested, ".note"),
  ]);
  assert.deepEqual(fromLeaf.issues, []);
  const fromRoot = await discoverNoteDirectories(directory);
  assert.deepEqual(fromRoot.paths, [join(directory, ".note")]);
});

test("resolveSources dedups identical roots, preserves hidden nested .note and marks untrusted projects", async (t) => {
  const { directory } = await fixture(t);
  const vault = join(directory, "vault");
  await mkdir(vault);
  const config = {
    directory: vault,
    maxContextBytes: DEFAULT_MAX_CONTEXT_BYTES,
  };
  const discovery = {
    paths: [vault, join(vault, ".note"), join(directory, "a", ".note")],
    issues: [],
  };
  const trusted = resolveSources(config, discovery, () => true);
  assert.deepEqual(
    trusted.map((source) => [source.kind, source.path, source.reason]),
    [
      ["global", vault, undefined],
      ["project", join(vault, ".note"), undefined],
      ["project", join(directory, "a", ".note"), undefined],
    ],
  );
  const untrusted = resolveSources(config, discovery, () => false);
  assert.equal(untrusted[0].reason, undefined);
  assert.equal(untrusted[1].reason, UNTRUSTED_REASON);
});

test("scan injects global first then project shallow to deep; reason-marked sources stay out of model context", async (t) => {
  const { directory, loader } = await fixture(t);
  const vault = join(directory, "vault");
  const shallow = join(directory, "pa", ".note");
  const deep = join(directory, "pb", "sub", ".note");
  for (const path of [vault, shallow, deep])
    await mkdir(path, { recursive: true });
  await writeFile(
    join(vault, "global.md"),
    "---\ndefaultopen: true\n---\nGLOBAL_BODY",
  );
  await writeFile(
    join(shallow, "shallow.md"),
    "---\ndefaultopen: true\n---\nSHALLOW_BODY",
  );
  await writeFile(
    join(deep, "deep.md"),
    "---\ndefaultopen: true\n---\nDEEP_BODY",
  );
  const config = {
    directory: vault,
    maxContextBytes: DEFAULT_MAX_CONTEXT_BYTES,
  };
  const result = await loader.scan(config, [
    { kind: "global", path: vault },
    { kind: "project", path: shallow },
    {
      kind: "project",
      path: join(directory, "hidden"),
      reason: UNTRUSTED_REASON,
    },
    { kind: "project", path: deep },
  ]);
  assert.equal(result.sources.length, 4);
  assert.ok(result.sources[0].text.startsWith("# 笔记"));
  assert.ok(
    result.text.indexOf("GLOBAL_BODY") < result.text.indexOf("SHALLOW_BODY"),
  );
  assert.ok(
    result.text.indexOf("SHALLOW_BODY") < result.text.indexOf("DEEP_BODY"),
  );
  assert.ok(!result.text.includes(UNTRUSTED_REASON));
  const hiddenSource = result.sources[2];
  assert.equal(hiddenSource.notes.length, 0);
  assert.equal(hiddenSource.skipped, UNTRUSTED_REASON);
  const preview = previewSnapshot(result);
  assert.ok(preview.includes("## 未注入来源"));
  assert.ok(preview.includes(UNTRUSTED_REASON));
});

test("budget excludes whole later sources and keeps earlier ones injectable", async (t) => {
  const { directory, loader } = await fixture(t);
  const first = join(directory, "first");
  const second = join(directory, "second");
  await mkdir(first);
  await mkdir(second);
  await writeFile(
    join(first, "a.md"),
    "---\ndefaultopen: true\n---\nFIRST_BODY",
  );
  await writeFile(
    join(second, "b.md"),
    "---\ndefaultopen: true\n---\nSECOND_BODY",
  );
  const config = {
    directory: null,
    maxContextBytes: DEFAULT_MAX_CONTEXT_BYTES,
  };
  const sources = [
    { kind: "project", path: first },
    { kind: "project", path: second },
  ] as const;
  const fitting = await loader.scan(config, [...sources]);
  assert.ok(fitting.text.includes("FIRST_BODY"));
  assert.ok(fitting.text.includes("SECOND_BODY"));
  const limit = fitting.sources[0].bytes + 1;
  const cut = await loader.scan({ ...config, maxContextBytes: limit }, [
    ...sources,
  ]);
  assert.ok(cut.text.includes("FIRST_BODY"));
  assert.ok(!cut.text.includes("SECOND_BODY"));
  assert.match(cut.sources[1].skipped!, /未注入/);
  assert.equal(cut.sources[1].notes.length, 0);
});

test("unreadable sources are skipped with reasons while other sources still inject", async (t) => {
  const { directory, loader } = await fixture(t);
  await writeFile(
    join(directory, "ok.md"),
    "---\ndefaultopen: true\n---\nOK_BODY",
  );
  const result = await loader.scan(
    { directory, maxContextBytes: DEFAULT_MAX_CONTEXT_BYTES },
    [
      { kind: "project", path: join(directory, "missing") },
      { kind: "project", path: directory },
    ],
  );
  assert.equal(result.sources[0].text, "");
  assert.match(result.sources[0].skipped!, /ENOENT/);
  assert.ok(result.text.includes("OK_BODY"));
  assert.ok(previewSnapshot(result).includes("missing"));
});
test("configuration: validation, quoted/spaced paths, atomic writes and invalid-file preservation", async (t) => {
  const { directory } = await fixture(t);
  const path = join(directory, "config", "notes.json");
  assert.equal((await loadConfig(path)).directory, null);
  const fallback = defaultNotesDirectory(path);
  await mkdir(fallback, { recursive: true });
  const realFallback = await realpath(fallback);
  assert.equal((await loadConfig(path)).directory, realFallback);
  await writeFile(path, "{}\n");
  assert.equal((await loadConfig(path)).directory, realFallback);
  await saveDirectory(path, null);
  assert.equal((await loadConfig(path)).directory, null);
  const vault = join(directory, "我的 Notes");
  await mkdir(vault);
  assert.equal(
    await validateDirectory('"我的 Notes"', directory),
    await validateDirectory(vault, directory),
  );
  await assert.rejects(validateDirectory("missing", directory));
  await saveDirectory(path, vault);
  assert.equal((await loadConfig(path)).directory, vault);
  await saveDirectory(path, null);
  assert.equal((await loadConfig(path)).directory, null);
  for (const invalid of [
    "[]",
    "{",
    '{"directory":"relative"}',
    '{"maxContextBytes":"1000"}',
    '{"maxContextBytes":-1}',
    '{"maxContextBytes":999999999}',
    '{"typo":true}',
  ]) {
    await writeFile(path, invalid);
    await assert.rejects(loadConfig(path));
    await assert.rejects(saveDirectory(path, vault));
    assert.equal(await readFile(path, "utf8"), invalid);
  }
});

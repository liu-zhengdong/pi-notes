import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
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
  loadConfig,
  saveDirectory,
  validateDirectory,
} from "../src/config.ts";
import {
  headerBounds,
  MAX_HEADER_BYTES,
  NotesLoader,
  parseMetadata,
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
  assert.equal(result.notes.length, 3);
  assert.equal(result.folders.length, 1);
  assert.equal(result.notes.find((n) => n.name === "USER.md")?.body, body);
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
  assert.equal((await loader.scan(config)).notes.length, 2);
  await unlink(path);
  assert.ok(!(await loader.scan(config)).text.includes("renamed"));
  const next = join(directory, "other");
  await mkdir(next);
  assert.equal(
    (await loader.scan({ ...config, directory: next })).notes.length,
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
  assert.equal(result.notes[0].body, undefined);
  assert.match(result.notes[0].error!, /文件超过/);
  await writeFile(
    path,
    `---\ndescription: ${"x".repeat(MAX_HEADER_BYTES)}\n---\nHEADER_SECRET`,
  );
  result = await loader.scan(config);
  assert.match(result.notes[0].error!, /frontmatter 超过/);
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
  assert.equal(result.notes[0].body, undefined);
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
  await assert.rejects(
    loader.scan({ ...config, maxContextBytes: size - 1 }),
    /本轮未注入/,
  );
});

test("rejects aggregate budget overflow rather than labelling truncated text as full", async (t) => {
  const { directory, config, loader } = await fixture(t);
  for (const name of ["a.md", "b.md", "c.md"])
    await writeFile(
      join(directory, name),
      `---\ndefaultopen: true\n---\n${"中".repeat(180)}`,
    );
  await assert.rejects(
    loader.scan({ ...config, maxContextBytes: 1024 }),
    /本轮未注入/,
  );
});

test("unreadable files and directories are reported, recover after repair", async (t) => {
  if (process.getuid?.() === 0 || process.platform === "win32")
    return t.skip("requires POSIX non-root permissions");
  const { directory, config, loader } = await fixture(t);
  const path = join(directory, "private.md");
  await writeFile(path, "---\ndefaultopen: true\n---\nPRIVATE");
  await chmod(path, 0);
  const result = await loader.scan(config);
  assert.equal(result.notes[0].body, undefined);
  assert.match(result.notes[0].error!, /EACCES/);
  await chmod(path, 0o600);
  assert.ok((await loader.scan(config)).text.includes("PRIVATE"));
  await chmod(directory, 0);
  try {
    await assert.rejects(loader.scan(config), /EACCES/);
  } finally {
    await chmod(directory, 0o700);
  }
});

test("configuration: validation, quoted/spaced paths, atomic writes and invalid-file preservation", async (t) => {
  const { directory } = await fixture(t);
  const path = join(directory, "config", "notes.json");
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

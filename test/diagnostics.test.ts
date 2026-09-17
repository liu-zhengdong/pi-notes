import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import notesExtension from "../src/index.ts";
import { KeywordStore } from "../src/keyword-store.ts";

async function fixture(t: TestContext, rootFailure = false) {
  const dir = await mkdtemp(join(tmpdir(), "notes-diagnostics-"));
  const vault = join(dir, "vault");
  const project = join(dir, "project");
  const agent = join(dir, "agent");
  await Promise.all([mkdir(vault), mkdir(join(project, ".git"), { recursive: true }), mkdir(agent)]);
  await writeFile(join(vault, "root.md"), rootFailure ? "---\ndefaultopen: invalid\n---\n" : "Root note");
  await writeFile(join(agent, "notes.json"), JSON.stringify({ directory: vault }));
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  let deepIssues: string[] = [];
  let nextPublication: Promise<void> | undefined;
  // Isolate the event/reporting boundary from native watcher timing. Root scans,
  // the extension handlers, notification formatting and deduplication stay real.
  t.mock.method(KeywordStore.prototype, "prepare", () => {});
  t.mock.method(KeywordStore.prototype, "publish", async function (this: KeywordStore) {
    const pending = nextPublication;
    nextPublication = undefined;
    if (pending) await pending;
    this.index.issues = [...deepIssues];
  });
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const warnings: string[] = [];
  const statuses: (string | undefined)[] = [];
  let commandHandler!: (args: string, ctx: ExtensionContext) => unknown;
  const selections: string[] = [];
  const inputs: string[] = [];
  const ctx = {
    cwd: project,
    hasUI: true,
    isIdle: () => true,
    isProjectTrusted: () => true,
    sessionManager: { getBranch: () => [], getLeafId: () => undefined },
    ui: {
      select: async (_title: string, options: string[]) => {
        const choice = selections.shift();
        if (choice !== undefined) assert.ok(options.includes(choice), `unavailable choice: ${choice}`);
        return choice;
      },
      input: async () => inputs.shift(),
      setStatus: (key: string, value: string | undefined) => {
        assert.equal(key, "pi-notes");
        statuses.push(value);
      },
      notify: (message: string, level: string) => {
        if (level === "warning") warnings.push(message);
      },
    },
  } as unknown as ExtensionContext;
  notesExtension({
    on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    registerCommand: (name: string, command: { handler: typeof commandHandler }) => {
      assert.equal(name, "notes");
      commandHandler = command.handler;
    },
    appendEntry: () => {},
    sendMessage: () => {},
  } as unknown as ExtensionAPI);
  const fire = async (name: string, event: object = {}) => {
    assert.ok(handlers.has(name), name);
    return await handlers.get(name)!(event, ctx);
  };
  t.after(async () => {
    await fire("session_shutdown");
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
    await rm(dir, { recursive: true, force: true });
  });
  const before = () => fire("before_agent_start", { systemPrompt: "BASE" });
  const context = () => fire("context", { messages: [] });
  const send = async () => { await before(); await context(); };
  return {
    warnings, statuses, fire, before, context, send,
    command: (args: string) => commandHandler(args, ctx),
    select: (choice: string, input?: string) => {
      selections.push(choice);
      if (input !== undefined) inputs.push(input);
    },
    createDirectory: async (name: string, failed: boolean) => {
      const path = join(dir, name);
      await mkdir(path);
      await writeFile(join(path, "root.md"), failed ? "---\ndefaultopen: invalid\n---\n" : "Root note");
      return path;
    },
    addProjectNotes: async () => {
      await mkdir(join(project, ".note"));
      await writeFile(join(project, ".note", "root.md"), "Project root");
    },
    setIssues: (issues: string[]) => { deepIssues = issues; },
    setRootFailure: (failed: boolean) => writeFile(join(vault, "root.md"), failed ? "---\ndefaultopen: invalid\n---\n" : "Root note"),
    disable: () => writeFile(join(agent, "notes.json"), JSON.stringify({ directory: null })),
    invalidateConfig: () => writeFile(join(agent, "notes.json"), JSON.stringify({ enabled: false })),
    holdNextPublication: () => {
      let finish!: (error?: Error) => void;
      nextPublication = new Promise<void>((resolve, reject) => { finish = error => error ? reject(error) : resolve(); });
      return async (error?: Error) => {
        finish(error);
        await new Promise<void>(resolve => setImmediate(resolve));
      };
    },
  };
}

for (const [name, issue, rootFailure] of [
  ["keyword", "deep/note.md：keywords 必须是字符串列表", false],
  ["watcher", "关键词文件监听不可用，改为后台定期检查：failure", false],
  ["cache", "关键词缓存未保存：failure", false],
  ["root and keyword", "deep/note.md：keywords 必须是字符串列表", true],
] as const) {
  test(`persistent ${name} failure warns once across startup and two sends`, async t => {
    const f = await fixture(t, rootFailure);
    f.setIssues([issue]);
    await f.fire("session_start");
    assert.equal(f.warnings.length, 1, "startup publishes one complete diagnosis");
    const warning = f.warnings[0];
    assert.ok(warning.includes(issue));
    if (rootFailure) assert.match(warning, /defaultopen/);
    for (let n = 0; n < 2; n++) {
      await f.before();
      assert.deepEqual(f.warnings, [warning], "preparation must not publish root-only warnings");
      const preparationStatus = f.statuses.at(-1)!;
      await f.context();
      await f.context(); // Tool continuation does not republish diagnostics.
      assert.deepEqual(f.warnings, [warning], "unchanged complete diagnosis is deduplicated");
      assert.match(preparationStatus, /!/, "retain the last complete failure while preparing");
    }
    t.diagnostic(JSON.stringify({ case: name, sends: 2, notifications: f.warnings }));
  });
}

test("only a complete recovery rearms warnings, and a changed or recurring error notifies", async t => {
  const f = await fixture(t);
  f.setIssues(["persistent failure"]);
  await f.before();
  assert.deepEqual(f.warnings, [], "no diagnosis before first complete publication");
  await f.context();
  assert.deepEqual(f.warnings, ["persistent failure"]);
  f.setIssues(["different failure"]);
  await f.send();
  assert.deepEqual(f.warnings, ["persistent failure", "different failure"]);
  f.setIssues([]);
  await f.before();
  assert.match(f.statuses.at(-1)!, /!/, "partial data is not proof of recovery");
  await f.context();
  assert.doesNotMatch(f.statuses.at(-1)!, /!/);
  f.setIssues(["different failure"]);
  await f.send();
  await f.send();
  assert.deepEqual(f.warnings, ["persistent failure", "different failure", "different failure"]);
  t.diagnostic(JSON.stringify({ case: "change-recover-recur", notifications: f.warnings }));
});

for (const entry of ["arguments", "menu"] as const) {
  test(`${entry} directory changes publish complete diagnostics and clear recovered status`, async t => {
    const f = await fixture(t);
    const bad = await f.createDirectory("bad", true);
    const good = await f.createDirectory("good", false);
    for (const path of [bad, good]) {
      if (entry === "menu") {
        f.select("更换笔记目录", path);
        await f.command("");
      } else await f.command(`set ${path}`);
      assert.equal(f.warnings.length, 1, "the bad directory warns during the command, not a later send");
      assert.match(f.warnings[0], /defaultopen/);
      if (path === bad) assert.match(f.statuses.at(-1)!, /!/);
      else assert.doesNotMatch(f.statuses.at(-1)!, /!/);
    }
    await f.send();
    await f.send();
    assert.equal(f.warnings.length, 1);
    t.diagnostic(JSON.stringify({ case: `${entry}-set`, notifications: f.warnings, status: f.statuses.at(-1) }));
  });

  test(`${entry} clear publishes remaining project diagnostics`, async t => {
    const f = await fixture(t, true);
    await f.fire("session_start");
    await f.addProjectNotes();
    f.setIssues(["project keyword failure"]);
    if (entry === "menu") {
      f.select("停用默认注入");
      await f.command("");
    } else await f.command("clear");
    assert.equal(f.warnings.at(-1), "project keyword failure");
    const count = f.warnings.length;
    await f.send();
    await f.send();
    assert.equal(f.warnings.length, count);
    t.diagnostic(JSON.stringify({ case: `${entry}-clear`, notifications: f.warnings, status: f.statuses.at(-1) }));
  });
}

for (const action of ["repaired", "disabled", "invalid-config", "shutdown"] as const) {
  for (const fails of [false, true]) {
    test(`stale startup ${fails ? "failure" : "success"} cannot report after ${action}`, async t => {
      const f = await fixture(t, true);
      const finishStartup = f.holdNextPublication();
      await f.fire("session_start");
      assert.deepEqual(f.warnings, []);
      if (action === "repaired") {
        await f.setRootFailure(false);
        await f.send();
      } else if (action === "disabled") {
        await f.disable();
        await f.send();
      } else if (action === "invalid-config") {
        await f.invalidateConfig();
        await f.before();
      } else {
        await f.fire("session_shutdown");
      }
      if (action === "invalid-config") assert.match(f.warnings.join("\n"), /未知字段：enabled/);
      else assert.deepEqual(f.warnings, []);
      const statuses = [...f.statuses];
      const warnings = [...f.warnings];
      await finishStartup(fails ? new Error("outdated startup failure") : undefined);
      assert.deepEqual(f.warnings, warnings, "old startup results must not change warning deduplication");
      assert.deepEqual(f.statuses, statuses, "old startup results must not overwrite current status");
    });
  }
}

test("terminal snapshot failures notify immediately and stay deduplicated", async t => {
  const f = await fixture(t);
  const { NotesLoader } = await import("../src/notes.ts");
  const broken = t.mock.method(NotesLoader.prototype, "scan", async () => { throw new Error("root scan failed"); });
  await f.before();
  await f.before();
  assert.deepEqual(f.warnings, ["root scan failed"]);
  assert.equal(f.statuses.at(-1), "notes · 异常");
  broken.mock.restore();
  await f.send();
  assert.doesNotMatch(f.statuses.at(-1)!, /异常|!/);
  assert.deepEqual(f.warnings, ["root scan failed"]);
});

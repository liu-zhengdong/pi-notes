import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Rpc } from "./rpc.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const artifact = join(repo, ".artifacts", `keywords-${Date.now()}`);
const raw = join(artifact, "raw");
const work = join(artifact, "work");
const agentDir = join(work, "agent");
const vault = join(work, "vault");
const project = join(work, "project");
const projectNotes = join(project, ".note");
for (const path of [
  raw,
  agentDir,
  join(vault, "deep"),
  join(projectNotes, "deep"),
  join(project, ".git"),
  join(project, ".pi"),
])
  await mkdir(path, { recursive: true });
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      (await readdir(join(repo, "src"))).map(async (name) => [
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
const note = (key: string, summary: string) =>
  `---\nkeywords: [${key}]\ndescription: ${summary}\npurpose: Reference for ${key}\ndefaultopen: true\n---\nPRIVATE_${summary}\n`;
await writeFile(
  join(vault, "root.md"),
  "---\nkeywords: [root-key]\ndescription: ROOT_GUIDE\n---\nPRIVATE_ROOT\n",
);
for (const word of [
  "user",
  "thought",
  "reply",
  "final",
  "tool",
  "arg",
  "crash",
  "midrun",
])
  await writeFile(
    join(vault, "deep", `${word}.md`),
    note(`${word}-key`, `HINT_${word.toUpperCase()}`),
  );
await writeFile(
  join(projectNotes, "root.md"),
  "---\nkeywords: [project-root-key]\ndescription: PROJECT_ROOT_GUIDE\n---\n",
);
await writeFile(
  join(projectNotes, "deep", "project.md"),
  note("project-key", "HINT_PROJECT"),
);
const toolPath = join(work, "arg-key.txt");
await writeFile(toolPath, "tool-key");
await writeFile(join(project, ".pi", "settings.json"), "{}\n");
await writeFile(
  join(agentDir, "settings.json"),
  JSON.stringify({
    retry: { enabled: false },
    compaction: { enabled: false, keepRecentTokens: 1 },
    lastChangelogVersion: "0.85.1",
  }),
);
await writeFile(
  join(agentDir, "notes.json"),
  JSON.stringify({ directory: vault }),
);
const requests: any[] = [];
let nextText: string | undefined;
let hold = false;
let toolThenHold = false;
let arrived: (() => void) | undefined;
const server = createServer(async (request, response) => {
  try {
    let data = "";
    for await (const chunk of request) data += chunk;
    const body = JSON.parse(data);
    requests.push(body);
    const n = requests.length;
    await writeFile(join(raw, `request-${n}.json`), data);
    if (n > 20) {
      response.writeHead(429).end();
      return;
    }
    if (hold) {
      arrived?.();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (delta: object, finish_reason: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id: `kw-${n}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    emit({ role: "assistant" });
    if (toolThenHold) {
      toolThenHold = false;
      hold = true;
      emit({
        tool_calls: [
          {
            index: 0,
            id: "call_midrun",
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: toolPath }),
            },
          },
        ],
      });
      emit({}, "tool_calls");
    } else if (n === 1) {
      // Keywords deliberately cross streaming delta boundaries.
      emit({ reasoning_content: "thought-" });
      emit({ reasoning_content: "key" });
      emit({ content: "reply-" });
      emit({ content: "key" });
      emit({
        tool_calls: [
          {
            index: 0,
            id: "call_read",
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: toolPath }),
            },
          },
        ],
      });
      emit({}, "tool_calls");
    } else {
      emit({ content: nextText ?? (n === 2 ? "final-key" : "OK") });
      nextText = undefined;
      emit({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address === "object");
const env = {
  ...process.env,
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
  NOTES_TEST_TRUST: "yes",
  NOTES_TEST_URL: `http://127.0.0.1:${address.port}/v1`,
};
const args = [
  "--approve",
  "--no-extensions",
  "--no-context-files",
  "--no-skills",
  "--no-prompt-templates",
  "-e",
  join(repo, "src/index.ts"),
  "-e",
  join(repo, "test/keyword-fixture.ts"),
  "--provider",
  "notes-fixture",
  "--model",
  "fixture",
  "--tools",
  "read",
];
const content = (n = requests.length) =>
  JSON.stringify(requests[n - 1].messages);
const count = (text: string, n = requests.length) =>
  content(n).split(text).length - 1;
let rpc = new Rpc(args, project, env, raw);
try {
  await rpc.prompt("user-key root-key project-key project-root-key");
  assert.equal(
    requests.length,
    2,
    "only original + tool continuation, never an extra reminder turn",
  );
  for (const marker of [
    "HINT_USER",
    "HINT_PROJECT",
    "ROOT_GUIDE",
    "PROJECT_ROOT_GUIDE",
  ])
    assert.ok(content(1).includes(marker), marker);
  assert.equal(count("HINT_USER", 1), 1);
  for (const marker of [
    "HINT_THOUGHT",
    "HINT_REPLY",
    "HINT_FINAL",
    "HINT_TOOL",
    "HINT_ARG",
    "PRIVATE_",
  ])
    assert.ok(!content(1).includes(marker), marker);
  for (const marker of [
    "HINT_USER",
    "HINT_PROJECT",
    "HINT_THOUGHT",
    "HINT_REPLY",
  ])
    assert.equal(count(marker, 2), 1, marker);
  for (const marker of ["HINT_FINAL", "HINT_TOOL", "HINT_ARG"])
    assert.ok(!content(2).includes(marker), marker);
  assert.ok(
    rpc.events.some(
      (event) =>
        event.type === "message_update" &&
        event.assistantMessageEvent?.type === "thinking_delta",
    ),
    "real host exposed streamed thinking",
  );
  await delay(200);
  assert.equal(requests.length, 2);
  const state = (await rpc.request("get_state")).data;
  assert.ok(state.sessionFile);
  // Final pending survives process restart and even compaction before its first delivery.
  await rpc.close();
  rpc = new Rpc([...args, "--session", state.sessionFile], project, env, raw);
  await rpc.request("compact");
  assert.equal(
    requests.length,
    2,
    "test compaction uses a deterministic extension, not a model",
  );
  await rpc.prompt("continue without matching words");
  assert.equal(count("HINT_FINAL"), 1);
  for (const marker of ["HINT_USER", "HINT_PROJECT"])
    assert.equal(
      count(marker),
      0,
      "compacted delivered reminder must not resurrect",
    );
  for (const marker of ["HINT_THOUGHT", "HINT_REPLY"])
    assert.equal(
      count(marker),
      1,
      "retained tail reminders stay available without duplicates",
    );
  await rpc.prompt("user-key project-key thought-key reply-key final-key");
  for (const marker of [
    "HINT_USER",
    "HINT_PROJECT",
    "HINT_THOUGHT",
    "HINT_REPLY",
    "HINT_FINAL",
  ])
    assert.equal(count(marker), 1, marker);
  await rpc.prompt("user-key project-key thought-key reply-key final-key");
  for (const marker of [
    "HINT_USER",
    "HINT_PROJECT",
    "HINT_THOUGHT",
    "HINT_REPLY",
    "HINT_FINAL",
  ])
    assert.equal(count(marker), 1, `repeat ${marker}`);
  // Fork before the original user: no reminder/journal hit may cross from its sibling.
  const forks = (await rpc.request("get_fork_messages")).data.messages;
  await rpc.request("fork", { entryId: forks[0].entryId });
  await rpc.prompt("unrelated branch");
  for (const marker of [
    "HINT_USER",
    "HINT_PROJECT",
    "HINT_THOUGHT",
    "HINT_REPLY",
    "HINT_FINAL",
  ])
    assert.equal(count(marker), 0, `fork ${marker}`);
  await rpc.prompt("project-key user-key");
  assert.equal(count("HINT_PROJECT"), 1);
  assert.equal(count("HINT_USER"), 1);
  // A lower budget filters retained reminders as well as new ones; pending can recover.
  await writeFile(
    join(agentDir, "notes.json"),
    JSON.stringify({ directory: vault, maxContextBytes: 1024 }),
  );
  await rpc.prompt("thought-key reply-key final-key");
  assert.ok(
    rpc.events.some(
      (event) =>
        event.method === "notify" && event.message.includes("关键词提醒超出"),
    ),
  );
  await writeFile(
    join(agentDir, "notes.json"),
    JSON.stringify({ directory: vault }),
  );
  await rpc.prompt("room is available again");
  for (const marker of [
    "HINT_USER",
    "HINT_PROJECT",
    "HINT_THOUGHT",
    "HINT_REPLY",
    "HINT_FINAL",
  ])
    assert.equal(count(marker), 1, `budget recovery ${marker}`);
  await writeFile(
    join(agentDir, "notes.json"),
    JSON.stringify({ directory: null }),
  );
  await rpc.prompt("user-key project-key");
  assert.equal(
    count("HINT_USER"),
    0,
    "disabled global source removes retained reminders",
  );
  assert.equal(
    count("HINT_PROJECT"),
    1,
    "project source remains independently active",
  );
  await rpc.close();
  rpc = new Rpc(
    [
      ...args.map((arg) => (arg === "--approve" ? "--no-approve" : arg)),
      "--session",
      state.sessionFile,
    ],
    project,
    env,
    raw,
  );
  await rpc.prompt("project-key");
  assert.equal(
    count("HINT_PROJECT"),
    0,
    "revoking trust filters retained project reminders",
  );
  assert.ok(!rpc.events.some((event) => event.type === "extension_error"));
  // Select the assistant itself, excluding its descendant hit checkpoint.
  await writeFile(
    join(agentDir, "notes.json"),
    JSON.stringify({ directory: vault }),
  );
  await rpc.close();
  rpc = new Rpc([...args, "--session", state.sessionFile], project, env, raw);
  await rpc.request("prompt", { message: "/notes-test-origin" });
  await rpc.prompt("continue from the chosen assistant");
  assert.equal(
    count("HINT_FINAL"),
    1,
    "tree selection must recover uncheckpointed origin",
  );
  // Kill the actual host after context assembly but before deferred messages flush.
  nextText = "crash-key";
  await rpc.prompt("stage an interruption");
  assert.equal(count("HINT_CRASH"), 0);
  const interrupted = (await rpc.request("get_state")).data.sessionFile;
  hold = true;
  const received = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await rpc.request("prompt", { message: "deliver pending without keyword" });
  const timer = setTimeout(() => arrived?.(), 10000);
  await received;
  clearTimeout(timer);
  assert.equal(count("HINT_CRASH"), 1);
  const exited = new Promise<void>((resolve) =>
    rpc.process.once("exit", () => resolve()),
  );
  rpc.process.kill("SIGKILL");
  await exited;
  server.closeAllConnections();
  hold = false;
  rpc = new Rpc([...args, "--session", interrupted], project, env, raw);
  await rpc.prompt("resume after process interruption");
  assert.equal(
    count("HINT_CRASH"),
    1,
    "queued-but-unsaved reminder survives SIGKILL",
  );
  // Persist a reminder at turn_end, die before agent_end, then compact it away.
  // Its durable delivery (without a settle delta) must not become pending again.
  const midrunSession = (await rpc.request("get_state")).data.sessionFile;
  toolThenHold = true;
  const continued = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await rpc.request("prompt", { message: "midrun-key" });
  const midrunTimer = setTimeout(() => arrived?.(), 10000);
  await continued;
  clearTimeout(midrunTimer);
  assert.equal(count("HINT_MIDRUN"), 1);
  const midrunExit = new Promise<void>((resolve) =>
    rpc.process.once("exit", () => resolve()),
  );
  rpc.process.kill("SIGKILL");
  await midrunExit;
  server.closeAllConnections();
  hold = false;
  const branchText = await readFile(midrunSession, "utf8");
  assert.ok(
    branchText.includes('"customType":"pi-notes-keyword"') &&
      branchText.includes("HINT_MIDRUN"),
  );
  rpc = new Rpc([...args, "--session", midrunSession], project, env, raw);
  await rpc.request("prompt", { message: "/notes-test-boundary" });
  await rpc.request("compact", { customInstructions: "notes-test-drop-all" });
  await rpc.prompt("continue after summarizing interrupted work");
  assert.equal(
    count("HINT_MIDRUN"),
    0,
    "durable delivery removed by compaction needs a fresh hit",
  );
  assert.ok(!rpc.events.some((event) => event.type === "extension_error"));
  assert.deepEqual(await hashes(), before, "tested source remains unchanged");
  await writeFile(
    join(raw, "result.json"),
    JSON.stringify(
      {
        passed: true,
        requests: requests.length,
        checks: [
          "same-request user",
          "streamed thought and reply across chunks",
          "normal tool continuation",
          "no tool/argument cascade",
          "no extra final turn",
          "root dedup",
          "global + trusted .note",
          "pending resume + compaction",
          "delivered compaction + fresh hits",
          "fork isolation",
          "retained reminder budget",
          "pending budget recovery",
          "source disable",
          "trust revoked",
          "tree at uncheckpointed assistant",
          "SIGKILL before deferred persistence",
          "durable turn_end delivery + SIGKILL before agent_end + compaction",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    `Keyword integration passed (${requests.length} local provider requests). Evidence: ${artifact}`,
  );
} finally {
  await rpc.close();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Rpc } from "./rpc.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const artifact = resolve(
  process.env.NOTES_TEST_ARTIFACTS ??
    join(repo, ".artifacts", `integration-${Date.now()}`),
);
const raw = join(artifact, "raw");
const work = join(artifact, "work");
const agentDir = join(work, "agent");
const vault = join(work, "我的 Notes");
await mkdir(raw, { recursive: true });
await mkdir(agentDir, { recursive: true });
await mkdir(join(vault, "项目", "深层"), { recursive: true });
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
await writeFile(
  join(vault, "USER.md"),
  "---\npurpose: USER_PURPOSE\ndefaultopen: true\n---\nFULL_ALPHA\n",
);
await writeFile(
  join(vault, "参考.md"),
  "---\npurpose: REFERENCE_PURPOSE\ndescription: SUMMARY_ALPHA\ndefaultopen: false\n---\nHIDDEN_BODY\n",
);
await writeFile(
  join(vault, "项目", "深层", "任务.md"),
  "---\ndefaultopen: true\n---\nNESTED_HIDDEN\n",
);
const requests: any[] = [];
const server = createServer(async (request, response) => {
  try {
    let data = "";
    for await (const chunk of request) data += chunk;
    const body = JSON.parse(data);
    requests.push(body);
    await writeFile(join(raw, `request-${requests.length}.json`), data);
    if (requests.length > 16) {
      response.writeHead(429).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const common = {
      id: `fixture-${requests.length}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
    };
    response.write(
      `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 } })}\n\n`,
    );
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
  NOTES_TEST_URL: `http://127.0.0.1:${address.port}/v1`,
};
await writeFile(
  join(agentDir, "settings.json"),
  JSON.stringify({
    lastChangelogVersion: "0.85.1",
    retry: { enabled: false },
    compaction: { enabled: false },
  }),
);
let rpc: Rpc | undefined;
try {
  // Run the documented installation entrypoint, with only its config directory isolated.
  const install = spawnSync(process.env.PI_TEST_BIN ?? "pi", ["install", "."], {
    cwd: repo,
    env,
    encoding: "utf8",
    timeout: 30000,
  });
  await writeFile(
    join(raw, "install.txt"),
    `${install.stdout}\n${install.stderr}`,
  );
  assert.equal(install.status, 0, install.stderr);
  rpc = new Rpc(
    [
      "--no-session",
      "--no-approve",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--append-system-prompt",
      "ORIGINAL_CONTEXT",
      "-e",
      join(repo, "test/fixture-provider.ts"),
      "--provider",
      "notes-fixture",
      "--model",
      "fixture",
    ],
    work,
    env,
    raw,
  );
  const commands = await rpc.request("get_commands");
  assert.ok(
    commands.data.commands.some((command: any) => command.name === "notes"),
  );
  await rpc.request("prompt", { message: `/notes set "${vault}"` });
  assert.equal(
    JSON.parse(await readFile(join(agentDir, "notes.json"), "utf8")).directory,
    vault,
  );
  const start = rpc.events.length;
  await rpc.request("prompt", { message: "/notes preview" });
  const preview = rpc.events
    .slice(start)
    .find(
      (event) =>
        event.method === "notify" && event.message.startsWith("# 笔记"),
    )?.message;
  assert.ok(preview, "RPC preview must be UI-only");
  await writeFile(join(raw, "preview.md"), preview);
  await rpc.prompt("first");
  const system = () =>
    requests
      .at(-1)
      .messages.filter((message: any) =>
        ["system", "developer"].includes(message.role),
      )
      .map((message: any) => message.content)
      .join("\n");
  assert.ok(
    system().includes(preview),
    "preview equals actual serialized context block",
  );
  for (const text of [
    "ORIGINAL_CONTEXT",
    "FULL_ALPHA",
    "USER_PURPOSE",
    "REFERENCE_PURPOSE",
    "SUMMARY_ALPHA",
    join(vault, "项目"),
  ])
    assert.ok(system().includes(text), text);
  for (const text of ["HIDDEN_BODY", "NESTED_HIDDEN"])
    assert.ok(!system().includes(text), text);
  await rpc.prompt("second");
  assert.equal(system().split("FULL_ALPHA").length - 1, 1);
  await writeFile(
    join(vault, "USER.md"),
    "---\npurpose: USER_PURPOSE\ndefaultopen: true\n---\nFULL_BETA\n",
  );
  await writeFile(
    join(vault, "新增.md"),
    "---\ndescription: CREATED_ENTRY\n---\nNEVER_BODY",
  );
  await rpc.prompt("after edit and create");
  assert.ok(
    system().includes("FULL_BETA") &&
      system().includes("CREATED_ENTRY") &&
      !system().includes("FULL_ALPHA"),
  );
  await rm(join(vault, "新增.md"));
  await writeFile(
    join(vault, "USER.md"),
    '---\ndefaultopen: "false"\n---\nMALFORMED_PRIVATE',
  );
  await rpc.prompt("after malformed edit and delete");
  assert.ok(system().includes("defaultopen 必须是布尔值"));
  for (const text of ["CREATED_ENTRY", "MALFORMED_PRIVATE", "FULL_BETA"])
    assert.ok(!system().includes(text));
  await rpc.request("new_session");
  await rpc.prompt("new session");
  assert.ok(system().includes("REFERENCE_PURPOSE"));
  const other = join(work, "other");
  await mkdir(other);
  await writeFile(
    join(other, "b.md"),
    "---\ndefaultopen: true\n---\nOTHER_VAULT",
  );
  await rpc.request("prompt", { message: `/notes set ${other}` });
  await rpc.prompt("after directory switch");
  assert.ok(system().includes("OTHER_VAULT") && !system().includes(vault));
  // A failed set must preserve the last valid configuration.
  await rpc.request("prompt", {
    message: `/notes set ${join(work, "missing")}`,
  });
  assert.equal(
    JSON.parse(await readFile(join(agentDir, "notes.json"), "utf8")).directory,
    other,
  );
  await rpc.request("prompt", { message: "/notes clear" });
  await rpc.prompt("after clear");
  assert.ok(
    !system().includes("OTHER_VAULT") && system().includes("ORIGINAL_CONTEXT"),
  );
  const messages = (await rpc.request("get_messages")).data.messages;
  assert.ok(
    !JSON.stringify(messages).includes("# 笔记"),
    "notes and previews must not be appended to history",
  );
  await writeFile(join(agentDir, "notes.json"), "{ invalid");
  await rpc.prompt("invalid config");
  assert.ok(
    system().includes("本轮笔记上下文不可用") &&
      !system().includes("OTHER_VAULT"),
  );
  assert.ok(!rpc.events.some((event) => event.type === "extension_error"));
  await writeFile(
    join(agentDir, "notes.json"),
    JSON.stringify({ directory: other }),
  );
  for (const mode of ["print", "json"]) {
    const result = spawnSync(
      process.env.PI_TEST_BIN ?? "pi",
      [
        "--no-session",
        "--no-approve",
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
        "-e",
        join(repo, "test/fixture-provider.ts"),
        "--provider",
        "notes-fixture",
        "--model",
        "fixture",
        ...(mode === "print" ? ["-p"] : ["--mode", "json"]),
        "/notes preview",
      ],
      {
        cwd: work,
        env: { ...env, NOTES_TEST_URL: "http://127.0.0.1:9/v1" },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    await writeFile(join(raw, `${mode}-stdout.txt`), result.stdout);
    await writeFile(join(raw, `${mode}-stderr.txt`), result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.stderr.includes("# 笔记") && result.stderr.includes("OTHER_VAULT"),
    );
    if (mode === "print") assert.equal(result.stdout.trim(), "");
    else
      for (const line of result.stdout.split("\n").filter(Boolean))
        JSON.parse(line);
  }
  assert.deepEqual(
    await hashes(),
    before,
    "source files unchanged during the experiment",
  );
  await writeFile(
    join(raw, "result.json"),
    JSON.stringify(
      {
        passed: true,
        requests: requests.length,
        assertions: [
          "local package install",
          "real Pi RPC command dispatch",
          "preview/outbound equality",
          "full and summary purpose",
          "root-only discovery",
          "refresh and no duplication",
          "malformed input rejection",
          "new session",
          "directory switch",
          "clear",
          "invalid config",
          "no history pollution",
          "print and JSON stderr preview",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    `Integration passed (${requests.length} local provider requests). Evidence: ${artifact}`,
  );
} finally {
  await rpc?.close();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}

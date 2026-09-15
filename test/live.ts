// Opt-in real-model verification. Uses a temporary copy of one configured provider credential.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Rpc } from "./rpc.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const original =
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const settings = JSON.parse(
  await readFile(join(original, "settings.json"), "utf8"),
);
const provider = process.env.NOTES_TEST_PROVIDER ?? settings.defaultProvider;
const model = process.env.NOTES_TEST_MODEL ?? settings.defaultModel;
const auth = JSON.parse(await readFile(join(original, "auth.json"), "utf8"));
assert.ok(
  typeof provider === "string" && typeof model === "string" && auth[provider],
  "A configured provider/model/credential is required",
);
const artifact = join(repo, ".artifacts", `live-${Date.now()}`);
const raw = join(artifact, "raw");
const work = join(artifact, "work");
const agentDir = join(work, "agent");
const vault = join(work, "vault");
await mkdir(raw, { recursive: true });
await mkdir(agentDir, { recursive: true, mode: 0o700 });
await cp(join(repo, "examples/vault"), vault, { recursive: true });
const hashSources = async () =>
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
const before = await hashSources();
await writeFile(
  join(raw, "source-hashes.json"),
  JSON.stringify(before, null, 2),
);
await writeFile(
  join(raw, "authentication-source.json"),
  JSON.stringify(
    {
      source: join(original, "auth.json"),
      provider,
      type: auth[provider].type,
      isolation:
        "temporary credential copy; credential file excluded from evidence and removed on exit",
    },
    null,
    2,
  ),
);
await writeFile(
  join(agentDir, "auth.json"),
  JSON.stringify({ [provider]: auth[provider] }),
  { mode: 0o600 },
);
await writeFile(
  join(agentDir, "settings.json"),
  JSON.stringify({
    lastChangelogVersion: "0.85.1",
    retry: { enabled: false },
    compaction: { enabled: false },
  }),
);
await writeFile(
  join(agentDir, "notes.json"),
  JSON.stringify({ directory: vault }),
);
console.log(
  `Live check: ${provider}/${model}; ${auth[provider].type} credential from ${original}/auth.json. Limit: 8 requests, 150 seconds.`,
);
const rpc = new Rpc(
  [
    "--no-session",
    "--no-approve",
    "--no-extensions",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "-e",
    join(repo, "src/index.ts"),
    "-e",
    join(repo, "test/observe.ts"),
    "--provider",
    provider,
    "--model",
    model,
    "--thinking",
    "low",
    "--tools",
    "read,ls,find,grep",
  ],
  work,
  {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    NOTES_OBSERVE_DIR: raw,
  },
  raw,
);
try {
  const state = (await rpc.request("get_state")).data;
  assert.equal(state.model.provider, provider);
  assert.equal(state.model.id, model);
  const start = rpc.events.length;
  await rpc.request("prompt", { message: "/notes preview" });
  const preview = rpc.events
    .slice(start)
    .find(
      (event) =>
        event.method === "notify" && event.message.startsWith("# 笔记"),
    )?.message;
  assert.ok(preview && !preview.includes("ALPHA-731"));
  await writeFile(join(raw, "preview.md"), preview);
  await rpc.prompt(
    "请从笔记目录的文件夹入口查找 Alpha 的验收口令；先逐层列目录定位文件，再读取原文。仅回答口令与来源路径。",
    150000,
  );
  const answer = (await rpc.request("get_last_assistant_text")).data.text;
  assert.ok(answer.includes("ALPHA-731"), answer);
  const calls = rpc.events.filter(
    (event) => event.type === "tool_execution_start",
  );
  assert.ok(calls.some((event) => event.toolName === "ls"));
  assert.ok(
    calls.some(
      (event) =>
        event.toolName === "read" && event.args.path.includes("验收.md"),
    ),
  );
  const first = await readFile(join(raw, "request-1.json"), "utf8");
  assert.ok(
    !first.includes("ALPHA-731"),
    "answer must come from a tool, not default injection",
  );
  assert.deepEqual(await hashSources(), before);
  await writeFile(
    join(raw, "result.json"),
    JSON.stringify(
      {
        passed: true,
        answer,
        tools: calls.map((event) => ({
          name: event.toolName,
          args: event.args,
        })),
        requests: (await readdir(raw)).filter((name) => /^request-/.test(name))
          .length,
      },
      null,
      2,
    ),
  );
  console.log(`Live model passed. Evidence: ${artifact}`);
} finally {
  await rpc.close();
  await rm(join(agentDir, "auth.json"), { force: true });
}

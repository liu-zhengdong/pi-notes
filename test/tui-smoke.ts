// Real TUI exercise via an isolated tmux server; captures the rendered terminal cell grid.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const artifact = join(repo, ".artifacts", `tui-${Date.now()}`);
const raw = join(artifact, "raw");
const agent = join(artifact, "work", "agent");
const vault = join(artifact, "work", "Notes 中文");
await mkdir(raw, { recursive: true });
await mkdir(agent, { recursive: true });
await cp(join(repo, "examples/vault"), vault, { recursive: true });
await writeFile(
  join(agent, "settings.json"),
  JSON.stringify({ lastChangelogVersion: "0.85.1" }),
);
const socket = `pi-notes-${process.pid}`;
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const tmux = (...args: string[]) => {
  const result = spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
};
const pause = () => new Promise((done) => setTimeout(done, 180));
async function waitFor(text: string): Promise<string> {
  for (let i = 0; i < 80; i++) {
    const screen = tmux("capture-pane", "-p", "-t", "notes");
    if (screen.includes(text)) return screen;
    await pause();
  }
  const failed = tmux("capture-pane", "-p", "-t", "notes");
  await writeFile(join(raw, "failure.txt"), `Expected: ${text}\n${failed}`);
  throw new Error(`TUI did not show ${text}\n${failed}`);
}
const key = (name: string) => tmux("send-keys", "-t", "notes", name);
const type = (text: string) => tmux("send-keys", "-t", "notes", "-l", text);
// Separate a preceding Escape from text so the terminal does not combine it into Alt+key.
const command = async (text: string) => {
  await pause();
  type(text);
  key("Enter");
  await pause();
};
async function capture(name: string): Promise<void> {
  await pause();
  await writeFile(
    join(raw, `${name}.txt`),
    tmux("capture-pane", "-p", "-t", "notes"),
  );
  await writeFile(
    join(raw, `${name}.ansi`),
    tmux("capture-pane", "-p", "-e", "-t", "notes"),
  );
}
const args = [
  "env",
  `PI_CODING_AGENT_DIR=${agent}`,
  "PI_OFFLINE=1",
  "PI_TELEMETRY=0",
  "NOTES_TEST_URL=http://127.0.0.1:9/v1",
  process.env.PI_TEST_BIN ?? "pi",
  "--no-session",
  "--no-approve",
  "--no-extensions",
  "--no-context-files",
  "--no-skills",
  "--no-prompt-templates",
  "-e",
  join(repo, "src/index.ts"),
  "-e",
  join(repo, "test/fixture-provider.ts"),
  "--provider",
  "notes-fixture",
  "--model",
  "fixture",
];
try {
  tmux(
    "new-session",
    "-d",
    "-s",
    "notes",
    "-x",
    "100",
    "-y",
    "40",
    "-c",
    repo,
    `sleep 0.3; ${args.map(quote).join(" ")}`,
  );
  tmux("set-option", "-g", "extended-keys", "on");
  tmux("set-option", "-g", "extended-keys-format", "csi-u");
  await waitFor("0.0%/128k");
  await new Promise((done) => setTimeout(done, 600));
  await command("/notes");
  await waitFor("设置笔记目录");
  await capture("01-empty");
  key("Enter");
  await waitFor("全局");
  await capture("02-directory-input");
  await command(vault);
  await waitFor("查看注入预览");
  await capture("03-menu");
  assert.equal(
    JSON.parse(await readFile(join(agent, "notes.json"), "utf8")).directory,
    vault,
  );
  key("Enter");
  await waitFor("只读预览");
  await capture("04-preview");
  key("PageDown");
  await capture("05-preview-scrolled");
  tmux("resize-window", "-t", "notes", "-x", "44", "-y", "24");
  await capture("06-narrow-preview");
  key("PageDown");
  await capture("07-narrow-scrolled");
  key("Escape");
  await waitFor("查看注入预览");
  await capture("08-narrow-menu");
  key("Escape");
  tmux("resize-window", "-t", "notes", "-x", "100", "-y", "40");
  await command("/notes set /missing-pi-notes-test-folder");
  await waitFor("ENOENT");
  await capture("09-invalid-path");
  assert.equal(
    JSON.parse(await readFile(join(agent, "notes.json"), "utf8")).directory,
    vault,
  );
  await writeFile(
    join(vault, "USER.md"),
    '---\ndefaultopen: "false"\n---\nPRIVATE_BODY',
  );
  await command("/notes preview");
  await waitFor("只读预览");
  await capture("10-malformed-preview");
  assert.ok(
    !tmux("capture-pane", "-p", "-t", "notes").includes("PRIVATE_BODY"),
  );
  key("Escape");
  await command("/notes clear");
  await waitFor("已停用默认注入");
  await capture("11-disabled");
  assert.equal(
    JSON.parse(await readFile(join(agent, "notes.json"), "utf8")).directory,
    null,
  );
  // A moved/missing folder must not make the UI's configuration action unreachable.
  await writeFile(
    join(agent, "notes.json"),
    JSON.stringify({ directory: "/missing-pi-notes-test-folder" }),
  );
  await command("/notes");
  await waitFor("设置笔记目录");
  await capture("12-recovery-menu");
  key("Escape");
  await writeFile(
    join(raw, "result.json"),
    JSON.stringify(
      {
        passed: true,
        viewports: [
          [100, 40],
          [44, 24],
        ],
        captures: 12,
        modelRequests: 0,
      },
      null,
      2,
    ),
  );
  console.log(`TUI passed. Evidence: ${artifact}`);
} finally {
  spawnSync("tmux", ["-L", socket, "kill-server"], { timeout: 5000 });
}

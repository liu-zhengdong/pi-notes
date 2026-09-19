import { join } from "node:path";
import {
  getAgentDir,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  defaultNotesDirectory,
  errorMessage,
  loadConfig,
  saveDirectory,
  validateDirectory,
} from "./config.ts";
import {
  discoverNoteDirectories,
  NotesLoader,
  resolveSources,
  type Snapshot,
} from "./notes.ts";
import { KeywordStore } from "./keyword-store.ts";
import { JOURNAL_TYPE, Reminders } from "./reminders.ts";
import {
  notify,
  showPreview,
  sourceLabel,
  summary,
  terminalText,
} from "./ui.ts";

const HELP =
  "/notes — 查看目录与注入清单\n/notes set <目录> — 设置全局笔记目录（支持空格与 ~）\n/notes preview — 预览默认上下文\n/notes clear — 停用默认注入，不删除笔记\n未配置时使用 agent 目录下的 notes/（若存在）；受信任项目内的 .note 目录会自动注入；/notes preview 可确认";

function globalProblem(snapshot: Snapshot): string | undefined {
  const global = snapshot.sources.find((source) => source.kind === "global");
  return global?.skipped;
}

function injectedNotes(snapshot: Snapshot): number {
  return snapshot.sources.reduce(
    (count, source) => count + (source.text ? source.notes.length : 0),
    0,
  );
}

export default function notesExtension(pi: ExtensionAPI): void {
  const configPath = join(getAgentDir(), "notes.json");
  const loader = new NotesLoader();
  const store = new KeywordStore(join(getAgentDir(), "cache", "pi-notes"));
  const index = store.index;
  let requestSnapshot: Snapshot | undefined;
  let publishPending = false;
  let lifecycle = 0;
  let snapshotRevision = 0;
  const reminders = new Reminders(index);
  let contextLimit = 0;
  let previousWarning = "";
  let previousOverflow = 0;

  // Preparation can update progress, but cannot establish diagnostic recovery.
  function updateStatus(
    ctx: ExtensionContext,
    snapshot?: Snapshot,
    failure?: string,
  ): void {
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        "pi-notes",
        failure
          ? "notes · 异常"
          : snapshot
          ? `notes · ${injectedNotes(snapshot)} 笔记${
              store.pending ? " · 索引准备中" : ""
            }${snapshot.issues.length || previousWarning ? " · !" : ""}`
          : undefined,
      );
    }
  }

  // Only a complete diagnosis (or a terminal failure) advances warning deduplication.
  function report(
    ctx: ExtensionContext,
    snapshot?: Snapshot,
    failure?: string,
  ): void {
    const warning = failure ?? snapshot?.issues.join("\n") ?? "";
    if (warning && warning !== previousWarning) {
      const lines = warning.split("\n");
      notify(
        ctx,
        lines.slice(0, 3).join("\n") +
          (lines.length > 3
            ? `\n另有 ${lines.length - 3} 项；/notes preview 查看。`
            : ""),
        "warning",
      );
    }
    previousWarning = warning;
    updateStatus(ctx, snapshot, failure);
  }

  async function snapshot(
    ctx: ExtensionContext,
  ): Promise<Snapshot | undefined> {
    snapshotRevision++;
    const config = await loadConfig(configPath);
    contextLimit = config.maxContextBytes;
    const discovery = await discoverNoteDirectories(ctx.cwd);
    const sources = resolveSources(config, discovery, () =>
      ctx.isProjectTrusted(),
    );
    if (!sources.length) {
      loader.clear();
      store.reset();
      report(ctx);
      return;
    }
    const result = await loader.scan(config, sources);
    store.prepare(result);
    updateStatus(ctx, result);
    return result;
  }

  // Explicit configuration commands finish validation before returning to the user.
  async function completeSnapshot(ctx: ExtensionContext): Promise<Snapshot | undefined> {
    const currentLifecycle = lifecycle;
    const revision = snapshotRevision + 1;
    const current = await snapshot(ctx);
    await store.publish();
    if (currentLifecycle === lifecycle && revision === snapshotRevision) {
      if (current) current.issues.push(...index.issues);
      report(ctx, current);
    }
    return current;
  }

  async function setDirectory(
    input: string,
    ctx: ExtensionContext,
  ): Promise<Snapshot | undefined> {
    const directory = await validateDirectory(input, ctx.cwd);
    await withFileMutationQueue(configPath, () =>
      saveDirectory(configPath, directory),
    );
    loader.clear();
    notify(
      ctx,
      `已设置全局笔记目录：${directory}\n下一轮生效；默认注入内容会发送给当前模型。`,
    );
    return completeSnapshot(ctx);
  }

  const restore = (_event: unknown, ctx: ExtensionContext): void => {
    reminders.restore(ctx.sessionManager.getBranch());
  };
  pi.on("session_start", async (event, ctx) => {
    restore(event, ctx);
    const currentLifecycle = ++lifecycle;
    const currentRevision = snapshotRevision + 1; // The snapshot below owns this revision.
    const isCurrent = () => currentLifecycle === lifecycle && currentRevision === snapshotRevision;
    try {
      const current = await snapshot(ctx);
      // Do not block opening the session on recursive discovery.
      void store
        .publish()
        .then(() => {
          if (!isCurrent()) return;
          if (current) current.issues.push(...index.issues);
          report(ctx, current);
        })
        .catch((error) => {
          if (isCurrent()) report(ctx, undefined, errorMessage(error));
        });
    } catch (error) {
      if (!isCurrent()) return;
      store.reset();
      report(ctx, undefined, errorMessage(error));
    }
  });
  pi.on("session_tree", restore);
  pi.on("session_compact", restore);
  pi.on("session_shutdown", async () => {
    lifecycle++;
    await store.close();
    previousWarning = "";
  });

  const persist: Parameters<Reminders["finishTurn"]>[1] = (change) =>
    pi.appendEntry(JOURNAL_TYPE, change);
  function* tail(ctx: ExtensionContext) {
    let id = ctx.sessionManager.getLeafId();
    while (id) {
      const entry = ctx.sessionManager.getEntry(id);
      if (!entry) break;
      yield entry;
      id = entry.parentId;
    }
  }
  const origin = (
    ctx: ExtensionContext,
    role: "user" | "assistant",
  ): string | undefined => {
    for (const entry of tail(ctx))
      if (entry.type === "message" && entry.message.role === role)
        return entry.id;
  };
  pi.on("agent_end", (_event, ctx) => reminders.finishRun(tail(ctx), persist));
  pi.on("message_end", (event) => reminders.captureUser(event.message));
  pi.on("turn_end", (event, ctx) => {
    reminders.finishTurn(event.message, persist, origin(ctx, "assistant"));
  });
  pi.on("context", async (event, ctx) => {
    if (publishPending) {
      publishPending = false;
      // User message is already visible. A very early first request may still
      // need the background build; never silently miss its keyword matches.
      await store.publish();
      if (requestSnapshot) requestSnapshot.issues.push(...index.issues);
      report(ctx, requestSnapshot);
    }
    const result = reminders.context(
      event.messages,
      persist,
      (message) => pi.sendMessage(message, { triggerTurn: false }),
      () => origin(ctx, "user"),
    );
    if (result.omitted && result.omitted !== previousOverflow)
      notify(
        ctx,
        `关键词提醒超出剩余笔记预算：${result.omitted} 篇本轮未提供。默认笔记优先；可调整 maxContextBytes。`,
        "warning",
      );
    previousOverflow = result.omitted;
    return { messages: result.messages };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const result = await snapshot(ctx);
      requestSnapshot = result;
      publishPending = true;
      reminders.configure(result, contextLimit);
      if (result?.text)
        return { systemPrompt: `${event.systemPrompt}\n\n${result.text}` };
    } catch (error) {
      store.reset();
      requestSnapshot = undefined;
      publishPending = false;
      reminders.configure(undefined, 0);
      const message = errorMessage(error);
      report(ctx, undefined, message);
      // Tell the model about missing context without reusing stale notes.
      return {
        systemPrompt: `${event.systemPrompt}\n\n# 笔记\n本轮笔记上下文不可用：${message}\n请勿假定已加载笔记；用户可通过 /notes 检查配置。`,
      };
    }
  });

  pi.registerCommand("notes", {
    description: "配置笔记目录，查看默认注入内容",
    getArgumentCompletions(prefix) {
      return ["set", "preview", "clear", "help"]
        .filter((item) => item !== prefix && item.startsWith(prefix))
        .map((item) => ({ value: item, label: item }));
    },
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        notify(ctx, "请等当前回复结束后再使用 /notes。", "warning");
        return;
      }
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
      const command = match?.[1] ?? "";
      const argument = match?.[2]?.trim() ?? "";
      try {
        if (command === "help") {
          notify(ctx, `${HELP}\n配置文件：${configPath}`);
          return;
        }
        if (command === "set") {
          if (!argument) throw new Error("用法：/notes set <目录>");
          await setDirectory(argument, ctx);
          return;
        }
        if (argument || !["", "preview", "clear"].includes(command))
          throw new Error(HELP);
        if (command === "clear") {
          await withFileMutationQueue(configPath, () =>
            saveDirectory(configPath, null),
          );
          loader.clear();
          await completeSnapshot(ctx);
          notify(ctx, "已停用默认注入。笔记文件和已有会话历史保持不变。");
          return;
        }
        let current: Snapshot | undefined;
        let problem: string | undefined;
        try {
          current = await completeSnapshot(ctx);
        } catch (error) {
          if (command === "preview" || !ctx.hasUI) throw error;
          // Keep the settings entrypoint usable when a folder was moved or became unreadable.
          problem = errorMessage(error);
          report(ctx, undefined, problem);
        }
        if (current) problem = globalProblem(current);
        if (command === "preview") {
          if (!current)
            throw new Error(
              "尚未配置目录，也未发现项目 .note。使用 /notes set <目录> 设置。",
            );
          await showPreview(ctx, current);
          return;
        }
        if (!ctx.hasUI) {
          notify(
            ctx,
            current
              ? `${sourceLabel(current)}\n${summary(current)}\n${HELP}`
              : `尚未配置笔记目录。\n${HELP}`,
          );
          return;
        }
        // Pi's native picker keeps configuration secondary to the preview.
        while (true) {
          const title = problem
            ? `Pi Notes · 配置待检查\n${problem}`
            : current
            ? `Pi Notes\n${terminalText(sourceLabel(current))}\n${summary(
                current,
              )}`
            : `Pi Notes · 尚未配置目录`;
          const options = problem
            ? ["重新设置笔记目录"]
            : current
            ? ["查看注入预览", "更换笔记目录", "停用默认注入"]
            : ["设置笔记目录"];
          const choice = await ctx.ui.select(title, options);
          if (!choice) return;
          if (choice === "查看注入预览") {
            await showPreview(ctx, current!);
            current = await completeSnapshot(ctx);
          } else if (choice === "停用默认注入") {
            await withFileMutationQueue(configPath, () =>
              saveDirectory(configPath, null),
            );
            loader.clear();
            await completeSnapshot(ctx);
            notify(ctx, "已停用默认注入，笔记文件保持不变。");
            return;
          } else {
            const input = await ctx.ui.input(
              "笔记目录（全局；自动注入内容会发送给当前模型）",
              current?.directory ?? defaultNotesDirectory(configPath),
            );
            if (input === undefined) continue;
            current = await setDirectory(input, ctx);
          }
          problem = current ? globalProblem(current) : undefined;
        }
      } catch (error) {
        notify(ctx, errorMessage(error), "error");
      }
    },
  });
}

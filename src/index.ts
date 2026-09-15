import { join } from "node:path";
import {
  getAgentDir,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  errorMessage,
  loadConfig,
  saveDirectory,
  validateDirectory,
} from "./config.ts";
import { NotesLoader, type Snapshot } from "./notes.ts";
import { notify, showPreview, summary, terminalText } from "./ui.ts";

const HELP =
  "/notes — 查看目录与注入清单\n/notes set <目录> — 设置全局笔记目录（支持空格与 ~）\n/notes preview — 预览默认上下文\n/notes clear — 停用默认注入，不删除笔记";

export default function notesExtension(pi: ExtensionAPI): void {
  const configPath = join(getAgentDir(), "notes.json");
  const loader = new NotesLoader();
  let previousWarning = "";

  function report(
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
            ? `notes · ${snapshot.notes.length} 笔记${snapshot.issues.length ? " · !" : ""}`
            : undefined,
      );
    }
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
  }

  async function snapshot(
    ctx: ExtensionContext,
  ): Promise<Snapshot | undefined> {
    const config = await loadConfig(configPath);
    if (!config.directory) {
      loader.clear();
      report(ctx);
      return;
    }
    const result = await loader.scan(config);
    report(ctx, result);
    return result;
  }

  async function setDirectory(
    input: string,
    ctx: ExtensionContext,
  ): Promise<void> {
    const directory = await validateDirectory(input, ctx.cwd);
    await withFileMutationQueue(configPath, () =>
      saveDirectory(configPath, directory),
    );
    loader.clear();
    notify(
      ctx,
      `已设置全局笔记目录：${directory}\n下一轮生效；默认注入内容会发送给当前模型。`,
    );
    await snapshot(ctx);
  }

  pi.on("session_shutdown", () => {
    loader.clear();
    previousWarning = "";
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const result = await snapshot(ctx);
      if (result)
        return { systemPrompt: `${event.systemPrompt}\n\n${result.text}` };
    } catch (error) {
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
          report(ctx);
          notify(ctx, "已停用默认注入。笔记文件和已有会话历史保持不变。");
          return;
        }
        let current: Snapshot | undefined;
        let problem: string | undefined;
        try {
          current = await snapshot(ctx);
        } catch (error) {
          if (command === "preview" || !ctx.hasUI) throw error;
          // Keep the settings entrypoint usable when a folder was moved or became unreadable.
          problem = errorMessage(error);
          report(ctx, undefined, problem);
        }
        if (command === "preview") {
          if (!current)
            throw new Error("尚未配置目录。使用 /notes set <目录> 设置。");
          await showPreview(ctx, current);
          return;
        }
        if (!ctx.hasUI) {
          notify(
            ctx,
            current
              ? `${current.directory}\n${summary(current)}\n${HELP}`
              : `尚未配置笔记目录。\n${HELP}`,
          );
          return;
        }
        // Pi's native picker keeps configuration secondary to the preview.
        while (true) {
          const title = current
            ? `Pi Notes\n${terminalText(current.directory)}\n${summary(current)}`
            : `Pi Notes · ${problem ? "配置待检查" : "尚未配置目录"}`;
          const options = current
            ? ["查看注入预览", "更换笔记目录", "停用默认注入"]
            : [problem ? "重新设置笔记目录" : "设置笔记目录"];
          const choice = await ctx.ui.select(title, options);
          if (!choice) return;
          if (choice === "查看注入预览") {
            await showPreview(ctx, current!);
          } else if (choice === "停用默认注入") {
            await withFileMutationQueue(configPath, () =>
              saveDirectory(configPath, null),
            );
            loader.clear();
            report(ctx);
            notify(ctx, "已停用默认注入，笔记文件保持不变。");
            return;
          } else {
            const input = await ctx.ui.input(
              "笔记目录（全局；自动注入内容会发送给当前模型）",
              current?.directory ?? "~/Notes/AI",
            );
            if (input === undefined) continue;
            await setDirectory(input, ctx);
          }
          current = await snapshot(ctx);
          problem = undefined;
        }
      } catch (error) {
        notify(ctx, errorMessage(error), "error");
      }
    },
  });
}

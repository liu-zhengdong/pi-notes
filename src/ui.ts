import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Text,
  truncateToWidth,
  type Component,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";
import { previewSnapshot, type Snapshot } from "./notes.ts";

/** Terminal sanitization is display-only; model context retains the original note body. */
export function terminalText(text: string): string {
  return stripVTControlCharacters(text).replace(
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g,
    "",
  );
}

export function summary(snapshot: Snapshot): string {
  const injected = snapshot.sources.filter((source) => source.text);
  const notes = injected.reduce(
    (count, source) => count + source.notes.length,
    0,
  );
  const full = injected.reduce(
    (count, source) =>
      count + source.notes.filter((note) => note.body !== undefined).length,
    0,
  );
  const parts = [
    `${full} 全文`,
    `${notes - full} 按需`,
    `${injected.reduce((count, source) => count + source.folders.length, 0)} 文件夹`,
    `${(snapshot.bytes / 1024).toFixed(1)} KiB`,
  ];
  if (snapshot.issues.length) parts.push(`${snapshot.issues.length} 项提醒`);
  const skipped = snapshot.sources.filter((source) => source.skipped).length;
  if (skipped) parts.push(`${skipped} 未注入`);
  return parts.join(" · ");
}

export function sourceLabel(snapshot: Snapshot): string {
  const global = snapshot.sources.find((source) => source.kind === "global");
  return global?.path ?? "未设置全局目录（仅项目 .note）";
}

export function notify(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  const safe = terminalText(message);
  if (ctx.hasUI) ctx.ui.notify(safe, level);
  else process.stderr.write(`[pi-notes] ${safe}\n`);
}

/** Read-only, bounded-height source preview. Never adds a message to model history. */
export class NotesPreview implements Component {
  private text: Text;
  private offset = 0;
  private pageSize = 1;
  private totalLines = 0;
  private theme: Theme;
  private keys: KeybindingsManager;
  private rows: () => number;
  private done: () => void;
  private subtitle: string;

  constructor(
    text: string,
    subtitle: string,
    theme: Theme,
    keys: KeybindingsManager,
    rows: () => number,
    done: () => void,
  ) {
    this.text = new Text(terminalText(text), 0, 0);
    this.subtitle = subtitle;
    this.theme = theme;
    this.keys = keys;
    this.rows = rows;
    this.done = done;
  }

  handleInput(data: string): void {
    if (this.keys.matches(data, "tui.select.cancel")) return this.done();
    if (this.keys.matches(data, "tui.select.up")) this.offset--;
    else if (this.keys.matches(data, "tui.select.down")) this.offset++;
    else if (this.keys.matches(data, "tui.select.pageUp"))
      this.offset -= this.pageSize;
    else if (this.keys.matches(data, "tui.select.pageDown"))
      this.offset += this.pageSize;
    this.offset = Math.max(
      0,
      Math.min(this.offset, this.totalLines - this.pageSize),
    );
  }

  invalidate(): void {
    this.text.invalidate();
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const content = this.text.render(inner);
    this.totalLines = content.length;
    this.pageSize = Math.max(1, Math.min(28, this.rows() - 12));
    this.offset = Math.max(
      0,
      Math.min(this.offset, content.length - this.pageSize),
    );
    const line = (text: string): string => truncateToWidth(` ${text}`, width);
    const key = (id: Parameters<KeybindingsManager["getKeys"]>[0]): string =>
      this.keys.getKeys(id).join("/");
    return [
      this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
      line(this.theme.fg("accent", this.theme.bold("默认上下文 · 只读预览"))),
      line(this.theme.fg("muted", this.subtitle)),
      "",
      ...content.slice(this.offset, this.offset + this.pageSize).map(line),
      "",
      line(
        this.theme.fg(
          "dim",
          `${key("tui.select.cancel")} 返回 · ${key("tui.select.up")}/${key("tui.select.down")} 滚动 · ${key("tui.select.pageDown")} 翻页 · ${this.offset + 1}–${Math.min(content.length, this.offset + this.pageSize)} / ${content.length} 行`,
        ),
      ),
      this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
    ];
  }
}

export async function showPreview(
  ctx: ExtensionContext,
  snapshot: Snapshot,
): Promise<void> {
  const text = previewSnapshot(snapshot);
  if (ctx.mode !== "tui") {
    notify(ctx, text);
    return;
  }
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    const preview = new NotesPreview(
      text,
      summary(snapshot),
      theme,
      keys,
      () => tui.terminal.rows,
      done,
    );
    return {
      render: (width) => preview.render(width),
      invalidate: () => preview.invalidate(),
      handleInput: (data) => {
        preview.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

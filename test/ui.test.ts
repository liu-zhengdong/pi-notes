import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, Theme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { NotesPreview, terminalText } from "../src/ui.ts";

initTheme("dark");
// Identity colors isolate wrapping from the terminal's color capability detection.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const keys = new KeybindingsManager(TUI_KEYBINDINGS);

test("preview fits narrow and normal widths, scrolls, closes and sanitizes terminal controls", () => {
  let closed = false;
  const text = Array.from(
    { length: 100 },
    (_, i) => `第${i}行 用户偏好 ${"long/path/".repeat(8)}`,
  ).join("\n");
  const preview = new NotesPreview(
    text,
    "1 全文 · 2 按需",
    theme,
    keys,
    () => 40,
    () => {
      closed = true;
    },
  );
  for (const width of [1, 20, 44, 80, 120]) {
    const output = preview.render(width);
    assert.ok(output.length <= 35);
    assert.ok(
      output.every((line) => visibleWidth(line) <= width),
      `width ${width}`,
    );
  }
  const before = preview.render(80).join("\n");
  preview.handleInput("\x1b[6~");
  assert.notEqual(preview.render(80).join("\n"), before);
  preview.handleInput("\x1b");
  assert.equal(closed, true);
  assert.equal(terminalText("hello\x1b[2J\x00 world"), "hello world");
});

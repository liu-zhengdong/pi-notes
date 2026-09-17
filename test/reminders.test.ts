import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ContextEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { KeywordIndex } from "../src/keywords.ts";
import {
  JOURNAL_TYPE,
  REMINDER_TYPE,
  Reminders,
  triggerText,
} from "../src/reminders.ts";

type Message = ContextEvent["messages"][number];
const user = (content: string): Message => ({
  role: "user",
  content,
  timestamp: 1,
});
const assistant = (text: string, thinking = ""): Message => ({
  role: "assistant",
  content: [
    { type: "text", text },
    { type: "thinking", thinking },
  ],
  timestamp: 2,
  api: "openai-completions",
  model: "fixture",
  provider: "fixture",
  stopReason: "stop",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
function fixture(limit = 10000) {
  const index = new KeywordIndex();
  index.notes.set("/vault/deep/a.md", {
    path: "/vault/deep/a.md",
    name: "a.md",
    keywords: ["alpha"],
    description: "A_HINT beta",
  });
  index.notes.set("/vault/deep/b.md", {
    path: "/vault/deep/b.md",
    name: "b.md",
    keywords: ["beta"],
    purpose: "B_PURPOSE",
  });
  const reminders = new Reminders(index);
  reminders.configure(undefined, limit);
  const journal: SessionEntry[] = [];
  const sent: Message[] = [];
  const persist: Parameters<Reminders["context"]>[1] = (data) =>
    journal.push({
      type: "custom",
      customType: JOURNAL_TYPE,
      id: String(journal.length),
      parentId: journal.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
      data,
    });
  const context = (messages: Message[] = []) =>
    reminders.context(messages, persist, (message) => sent.push(message));
  let flushed = 0;
  const finish = (message: Message) => {
    reminders.finishTurn(message, persist);
    for (const message of sent.slice(flushed)) {
      if (message.role !== "custom") continue;
      journal.push({
        type: "custom_message",
        customType: message.customType,
        content: message.content,
        display: false,
        details: message.details,
        id: String(journal.length),
        parentId: journal.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
      });
    }
    flushed = sent.length;
    reminders.finishRun(journal.toReversed(), persist);
  };
  return { index, reminders, journal, sent, persist, context, finish };
}
const notes = (messages: Message[]) =>
  messages.filter((m) => m.role === "custom" && m.customType === REMINDER_TYPE);

test("user keywords affect same request; actual context dedup and no injected-content cascade", () => {
  const f = fixture();
  f.reminders.captureUser(user("ALPHA alpha"));
  assert.equal(
    f.journal.length,
    0,
    "do not persist hits before originating user",
  );
  const first = f.context([user("ALPHA alpha")]);
  assert.equal(notes(first.messages).length, 1);
  assert.match(JSON.stringify(first.messages), /A_HINT beta/);
  assert.ok(!JSON.stringify(first.messages).includes("B_PURPOSE"));
  f.finish(assistant("alpha"));
  const journalLength = f.journal.length;
  f.reminders.captureUser(user("alpha"));
  const second = f.context([
    ...first.messages,
    assistant("alpha"),
    user("alpha"),
  ]);
  assert.equal(notes(second.messages).length, 1);
  assert.equal(
    f.journal.length,
    journalLength,
    "no permanent whole-state rewrites or redundant hit deltas",
  );
});

test("assistant text/thinking stage only paths until next context; pending survives resume/compaction and stays branch-local", () => {
  const f = fixture();
  f.context([user("start")]);
  const branchBeforeHit = [...f.journal];
  f.finish(assistant("done", "alpha"));
  assert.equal(
    f.sent.length,
    0,
    "final reply must not queue a message or an extra turn",
  );
  const afterHit = [...f.journal];
  f.reminders.restore(afterHit);
  const next = f.context([user("continue without a keyword")]);
  assert.equal(notes(next.messages).length, 1);
  f.finish(assistant("OK"));
  f.reminders.restore(f.journal);
  assert.equal(
    notes(f.context(next.messages).messages).length,
    1,
    "resume sees existing reminder",
  );
  f.reminders.restore(branchBeforeHit);
  assert.equal(notes(f.context([user("other branch")]).messages).length, 0);
});

test("compacted reminders do not resurrect from historical hit journals; fresh hits reintroduce them", () => {
  const f = fixture();
  f.reminders.captureUser(user("alpha"));
  f.context([user("alpha")]);
  f.finish(assistant("OK"));
  f.reminders.restore(f.journal);
  assert.equal(
    notes(f.context([user("unrelated after compaction")]).messages).length,
    0,
  );
  f.reminders.captureUser(user("alpha"));
  assert.equal(notes(f.context([user("alpha")]).messages).length, 1);
});

test("budget keeps whole entries, preserves pending, defaults take priority, deleted sources cancel", () => {
  const f = fixture(1);
  f.reminders.captureUser(user("alpha beta"));
  const blocked = f.context([user("alpha beta")]);
  assert.equal(blocked.omitted, 2);
  assert.equal(notes(blocked.messages).length, 0);
  assert.equal(f.sent.length, 0);
  f.reminders.restore(f.journal);
  f.reminders.configure(undefined, 10000);
  assert.equal(notes(f.context([user("continue")]).messages).length, 2);
  f.finish(assistant("OK"));
  f.reminders.configure(undefined, 1);
  const hidden = f.context(f.sent);
  assert.equal(hidden.omitted, 2);
  assert.equal(
    notes(hidden.messages).length,
    0,
    "old reminders also obey budget",
  );
  f.index.clear();
  assert.equal(notes(f.context(f.sent).messages).length, 0);
});

test("fork at uncheckpointed origin recovers once; processed origins do not match new keywords", () => {
  for (const message of [assistant("alpha"), user("alpha")]) {
    const f = fixture();
    const origin: SessionEntry = {
      type: "message",
      message,
      id: "origin",
      parentId: null,
      timestamp: new Date().toISOString(),
    };
    f.reminders.restore([origin]);
    assert.equal(notes(f.context([message]).messages).length, 1);
    f.finish(assistant("OK"));
    // Delivered reminder compacted away: old text is processed, so do not replay it.
    f.reminders.restore([origin, ...f.journal]);
    assert.equal(notes(f.context([message]).messages).length, 0);
  }
});

test("queued reminders remain pending across interruption before deferred persistence", () => {
  const f = fixture();
  f.finish(assistant("alpha"));
  const first = f.context([user("continue")]);
  assert.equal(notes(first.messages).length, 1);
  assert.ok(
    !f.journal.some(
      (entry) =>
        entry.type === "custom" && (entry.data as any).action === "settle",
    ),
  );
  f.reminders.restore(f.journal); // process died while the provider was answering
  assert.equal(notes(f.context([user("retry")]).messages).length, 1);
  f.finish(assistant("OK"));
  assert.ok(
    f.journal.some(
      (entry) =>
        entry.type === "custom" && (entry.data as any).action === "settle",
    ),
  );
});

test("mid-run compaction recognizes durable delivery before agent_end without settling later fresh hits", () => {
  const f = fixture();
  f.reminders.captureUser(user("alpha"));
  f.context([user("alpha")]);
  const reminder = f.sent[0];
  assert.ok(reminder.role === "custom");
  f.journal.push({
    type: "custom_message",
    customType: REMINDER_TYPE,
    content: reminder.content,
    display: false,
    details: reminder.details,
    id: "delivered",
    parentId: f.journal.at(-1)!.id,
    timestamp: new Date().toISOString(),
  });
  // Pi persisted at turn_end, then compacted before agent_end could write settle.
  assert.ok(
    !f.journal.some(
      (entry) =>
        entry.type === "custom" && (entry.data as any).action === "settle",
    ),
  );
  f.reminders.restore(f.journal);
  assert.equal(notes(f.context([user("after compaction")]).messages).length, 0);
  f.reminders.captureUser(user("alpha"));
  assert.equal(notes(f.context([user("alpha")]).messages).length, 1);
  f.reminders.restore(f.journal); // fresh queued delivery is not saved yet
  assert.equal(notes(f.context([user("retry fresh hit")]).messages).length, 1);
});

test("tool continuation retains earlier reminders even when host snapshot omits them", () => {
  const f = fixture();
  f.reminders.captureUser(user("alpha"));
  f.context([user("alpha")]);
  f.reminders.finishTurn(assistant("beta"), f.persist);
  const second = f.context([user("alpha"), assistant("beta")]);
  assert.equal(notes(second.messages).length, 2);
  assert.equal(f.sent.length, 2, "bridge must not requeue the first reminder");
});

test("tool output, tool arguments, redacted thinking and custom messages cannot trigger matching", () => {
  const messages: Message[] = [
    {
      role: "toolResult",
      toolCallId: "tool",
      toolName: "read",
      content: [{ type: "text", text: "alpha" }],
      isError: false,
      timestamp: 1,
    },
    {
      role: "custom",
      customType: REMINDER_TYPE,
      content: "alpha",
      display: false,
      timestamp: 1,
    },
    {
      ...assistant(""),
      content: [
        {
          type: "toolCall",
          id: "tool",
          name: "read",
          arguments: { path: "alpha" },
        },
      ],
    } as Message,
    {
      ...assistant(""),
      content: [{ type: "thinking", thinking: "alpha", redacted: true }],
    } as Message,
  ];
  for (const message of messages) assert.equal(triggerText(message), "");
});

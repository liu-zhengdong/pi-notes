import { randomUUID } from "node:crypto";
import type {
  ContextEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { KeywordIndex } from "./keywords.ts";
import { renderNote, type Snapshot } from "./notes.ts";

type Message = ContextEvent["messages"][number];
type Reminder = Extract<Message, { role: "custom" }>;
export const REMINDER_TYPE = "pi-notes-keyword";
export const JOURNAL_TYPE = "pi-notes-keyword-state";
interface Change {
  version: 1;
  action: "hit" | "settle";
  paths: string[];
  origin?: string;
}
type Persist = (change: Change) => void;
interface Identity {
  version: 1;
  path: string;
  delivery?: string;
}

function identity(details: unknown): Identity | undefined {
  if (!details || typeof details !== "object") return;
  const data = details as Record<string, unknown>;
  if (data.version === 1 && typeof data.path === "string")
    return {
      version: 1,
      path: data.path,
      delivery: typeof data.delivery === "string" ? data.delivery : undefined,
    };
}

/** Only original conversation text, never tool calls/results or injected context. */
export function triggerText(message: Message): string {
  if (message.role !== "user" && message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .flatMap((part) => {
      if (part.type === "text") return [part.text];
      if (part.type === "thinking" && !part.redacted) return [part.thinking];
      return [];
    })
    .join("\n");
}

/** Branch-local deltas remember pending work, not a lifetime list of seen notes. */
export class Reminders {
  private pending = new Set<string>();
  private provided = new Set<string>();
  private roots = new Set<string>();
  private userTexts: string[] = [];
  private userPending = false;
  private recover?: { id: string; message: Message };
  private inFlight: Reminder[] = [];
  private defaultBytes = 0;
  private limit = 0;
  private index: KeywordIndex;
  constructor(index: KeywordIndex) {
    this.index = index;
  }

  restore(entries: readonly SessionEntry[]): void {
    this.pending.clear();
    this.provided.clear();
    this.userTexts = [];
    this.userPending = false;
    this.inFlight = [];
    this.recover = undefined;
    // A branch can end at the origin, just before its processing checkpoint.
    // Recover only that boundary message, never replay the conversation history.
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (
        entry.type === "message" &&
        (entry.message.role === "user" || entry.message.role === "assistant")
      ) {
        this.recover = { id: entry.id, message: entry.message };
        break;
      }
    }
    for (const entry of entries) {
      // A delivery can be saved during a tool loop before agent_end acknowledges
      // it. Replay durable messages in order too: compaction may already have
      // removed them from model context, but they must not become pending again.
      if (
        entry.type === "custom_message" &&
        entry.customType === REMINDER_TYPE
      ) {
        const data = identity(entry.details);
        if (data) this.pending.delete(data.path);
        continue;
      }
      if (entry.type !== "custom" || entry.customType !== JOURNAL_TYPE)
        continue;
      const change: unknown = entry.data;
      if (!change || typeof change !== "object") continue;
      const data = change as Record<string, unknown>;
      if (data.version !== 1 || !Array.isArray(data.paths)) continue;
      if (data.action === "hit" && data.origin === this.recover?.id)
        this.recover = undefined;
      for (const path of data.paths) {
        if (typeof path !== "string") continue;
        if (data.action === "hit") this.pending.add(path);
        else if (data.action === "settle") this.pending.delete(path);
      }
    }
  }

  configure(snapshot: Snapshot | undefined, limit: number): void {
    this.roots = new Set(
      snapshot?.sources
        .filter((source) => source.text)
        .flatMap((source) => source.notes.map((note) => note.path)) ?? [],
    );
    this.defaultBytes = snapshot?.bytes ?? 0;
    this.limit = limit;
    this.provided = new Set(this.roots);
  }

  captureUser(message: Message): void {
    if (message.role !== "user") return;
    this.userPending = true;
    // The first background build can finish between message_end and context.
    this.userTexts.push(triggerText(message));
  }

  private hit(
    paths: Iterable<string>,
    persist: Persist,
    origin?: string,
  ): void {
    const added: string[] = [];
    for (const path of paths) {
      if (
        this.provided.has(path) ||
        this.pending.has(path) ||
        !this.index.notes.has(path)
      )
        continue;
      this.pending.add(path);
      added.push(path);
    }
    // An empty checkpoint prevents old text from matching newly configured keywords
    // after resume. Each origin costs one tiny delta, not a whole-state rewrite.
    if (added.length || origin)
      persist({ version: 1, action: "hit", paths: added, origin });
  }

  private settle(paths: string[], persist: Persist): void {
    if (!paths.length) return;
    persist({ version: 1, action: "settle", paths });
    for (const path of paths) this.pending.delete(path);
  }

  /** Final replies record pending work only; they never queue a model turn. */
  finishTurn(message: Message, persist: Persist, origin?: string): void {
    if (message.role === "assistant")
      this.hit(this.index.match(triggerText(message)), persist, origin);
  }

  finishRun(entries: Iterable<SessionEntry>, persist: Persist): void {
    const deliveries = new Map(
      this.inFlight.flatMap((message) => {
        const data = identity(message.details);
        return data?.delivery ? [[data.delivery, data.path] as const] : [];
      }),
    );
    const saved: string[] = [];
    for (const entry of entries) {
      if (!deliveries.size) break;
      if (entry.type !== "custom_message" || entry.customType !== REMINDER_TYPE)
        continue;
      const data = identity(entry.details);
      if (data?.delivery && deliveries.get(data.delivery) === data.path) {
        if (this.pending.has(data.path)) saved.push(data.path);
        deliveries.delete(data.delivery);
      }
    }
    // A queued send is not durable. Only acknowledge its actual session entry.
    this.settle(saved, persist);
    this.inFlight = [];
  }

  context(
    messages: Message[],
    persist: Persist,
    send: (message: Reminder) => void,
    userOrigin?: () => string | undefined,
  ): { messages: Message[]; omitted: number } {
    const result: Message[] = [];
    const included = new Set(this.roots);
    const stored = new Set(this.roots);
    const omitted = new Set<string>();
    let used = this.defaultBytes;
    const makeReminder = (
      data: Identity,
      timestamp: number,
    ): Reminder | undefined => {
      const note = this.index.notes.get(data.path);
      if (!note || included.has(data.path)) return;
      const content = `# 相关笔记\n\n${renderNote(
        note,
      )}\n\n需要时可按路径读取全文。`;
      const cost = Buffer.byteLength(content) + 2;
      if (used + cost > this.limit) {
        omitted.add(data.path);
        return;
      }
      used += cost;
      included.add(data.path);
      return {
        role: "custom",
        customType: REMINDER_TYPE,
        content,
        display: false,
        details: data,
        timestamp,
      };
    };
    for (const message of messages) {
      if (message.role === "custom" && message.customType === REMINDER_TYPE) {
        const data = identity(message.details);
        const reminder = data && makeReminder(data, message.timestamp);
        if (reminder) {
          result.push(reminder);
          stored.add(data!.path);
        }
      } else result.push(message);
    }
    // Pi's active tool loop can retain a snapshot missing deferred custom messages,
    // even after the host has saved them. Keep this bridge until agent_end.
    for (const message of this.inFlight) {
      const data = identity(message.details);
      const reminder = data && makeReminder(data, message.timestamp);
      if (reminder) result.push(reminder);
    }
    this.provided = included;
    if (this.recover) {
      this.hit(
        this.index.match(triggerText(this.recover.message)),
        persist,
        this.recover.id,
      );
      this.recover = undefined;
    }
    // message_end precedes persistence; journal user hits here, after their origin.
    if (this.userPending)
      this.hit(
        this.userTexts.flatMap((text) => this.index.match(text)),
        persist,
        userOrigin?.(),
      );
    this.userTexts = [];
    this.userPending = false;
    this.settle(
      [...this.pending].filter(
        (path) => !this.index.notes.has(path) || stored.has(path),
      ),
      persist,
    );
    // Stable source/path order, no per-request sorting.
    for (const path of this.index.notes.keys()) {
      if (!this.pending.has(path) || included.has(path)) continue;
      const reminder = makeReminder(
        { version: 1, path, delivery: randomUUID() },
        Date.now(),
      );
      if (!reminder) continue;
      result.push(reminder);
      // context supplies this request; sendMessage only persists at a safe boundary.
      // Never use steer/followUp/nextTurn or triggerTurn:true.
      send(reminder);
      this.inFlight.push(reminder);
    }
    this.provided = included;
    return { messages: result, omitted: omitted.size };
  }
}

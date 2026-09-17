import { constants, type BigIntStats, type Dirent } from "node:fs";
import { lstat, open, readdir, stat, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { errorMessage, type NotesConfig } from "./config.ts";

export const MAX_HEADER_BYTES = 64 * 1024;
export interface Metadata {
  defaultopen: boolean;
  keywords?: string[];
  description?: string;
  purpose?: string;
}
export interface Note {
  name: string;
  path: string;
  description?: string;
  purpose?: string;
  body?: string;
  error?: string;
}
export interface Folder {
  name: string;
  path: string;
}
export type SourceKind = "global" | "project";

/** One note source for this round; `reason` excludes it before scanning. */
export interface SourceRequest {
  kind: SourceKind;
  path: string;
  reason?: string;
}
export interface SourceSnapshot {
  /** Identity of the selected root (following an explicitly configured symlink). */
  identity?: string;
  kind: SourceKind;
  path: string;
  notes: Note[];
  folders: Folder[];
  issues: string[];
  /** Rendered block injected this round; empty when excluded. */
  text: string;
  bytes: number;
  skipped?: string;
}
export interface Snapshot {
  directory: string | null;
  sources: SourceSnapshot[];
  issues: string[];
  text: string;
  bytes: number;
  reads: number;
  cacheHits: number;
}
export interface DiscoveryResult {
  paths: string[];
  issues: string[];
}

export const UNTRUSTED_REASON = "项目未受 Pi 信任，未注入其中的笔记。";

/** undefined means that a bounded prefix needs more data. Offsets are JS string offsets. */
export function headerBounds(
  text: string,
  eof: boolean,
): { source: string; bodyOffset: number } | undefined {
  const opening = /^\uFEFF?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!opening) return { source: "", bodyOffset: 0 };
  const delimiter = /^---[ \t]*(?:\r?\n|$)/gm;
  delimiter.lastIndex = opening[0].length;
  const closing = delimiter.exec(text);
  if (
    closing &&
    (closing[0].endsWith("\n") || delimiter.lastIndex < text.length || eof)
  ) {
    return {
      source: text.slice(opening[0].length, closing.index),
      bodyOffset: delimiter.lastIndex,
    };
  }
  if (eof) throw new Error("frontmatter 缺少结束的 ---");
  return undefined;
}

export function parseMetadata(source: string): Metadata {
  const document = parseDocument(source, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem)
    throw new Error(`frontmatter：${problem.message.split("\n")[0]}`);
  // Do not expand YAML aliases in automatically loaded context.
  const data: unknown =
    document.toJS({ maxAliasCount: 0, mapAsMap: true }) ?? new Map();
  if (!(data instanceof Map)) throw new Error("frontmatter 必须是字段映射");
  const fields: Map<unknown, unknown> = data;
  const defaultopen = fields.has("defaultopen")
    ? fields.get("defaultopen")
    : false;
  if (typeof defaultopen !== "boolean")
    throw new Error("defaultopen 必须是布尔值 true 或 false（不能加引号）");
  const result: Metadata = { defaultopen };
  if (fields.has("keywords")) {
    const value = fields.get("keywords");
    if (
      !Array.isArray(value) ||
      value.some((word) => typeof word !== "string" || !word.trim())
    )
      throw new Error("keywords 必须是字符串列表，每项去除空白后须非空");
    result.keywords = [
      ...new Set(value.map((word: string) => word.trim().toLowerCase())),
    ];
  }
  for (const key of ["description", "purpose"] as const) {
    const value = fields.get(key);
    if (value == null) continue;
    if (typeof value !== "string") throw new Error(`${key} 必须是文本`);
    if (value.trim()) result[key] = value.trim();
  }
  return result;
}

export const signature = (stat: BigIntStats): string =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const field = (label: string, value: string, indent = ""): string =>
  `${indent}${label}：${value.replace(/\r?\n/g, `\n${indent}  `)}`;

export function renderNote(note: Note): string {
  const full = note.body !== undefined;
  const lines = [full ? `### ${note.name}` : `- ${note.name}`];
  const indent = full ? "" : "  ";
  lines.push(field("路径", note.path, indent));
  if (note.purpose) lines.push(field("定位", note.purpose, indent));
  if (full) lines.push("", note.body!);
  else if (note.description)
    lines.push(field("描述", note.description, indent));
  if (note.error) lines.push(field("未展开", note.error, indent));
  return lines.join("\n");
}

/**
 * Locate `.note` directories from cwd up to the git root (or filesystem root).
 * Returned shallow to deep; unreadable ancestors stop the ascent silently,
 * but an unreadable cwd is reported.
 */
export async function discoverNoteDirectories(
  cwd: string,
): Promise<DiscoveryResult> {
  const paths: string[] = [];
  const issues: string[] = [];
  let current = resolve(cwd);
  for (;;) {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (current === resolve(cwd))
        issues.push(`无法读取工作目录：${errorMessage(error)}`);
      break;
    }
    const note = entries.find(
      (entry) =>
        entry.name === ".note" &&
        entry.isDirectory() &&
        !entry.isSymbolicLink(),
    );
    if (note) paths.push(join(current, ".note"));
    if (entries.some((entry) => entry.name === ".git")) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { paths: paths.reverse(), issues };
}

/** Global first, project shallow to deep. A nested .note is not covered by a
 * global ancestor: hidden directories are excluded from ordinary discovery. */
export function resolveSources(
  config: NotesConfig,
  discovery: DiscoveryResult,
  isTrusted: () => boolean,
): SourceRequest[] {
  const sources: SourceRequest[] = [];
  if (config.directory)
    sources.push({ kind: "global", path: config.directory });
  for (const path of discovery.paths) {
    if (config.directory && resolve(config.directory) === resolve(path))
      continue;
    sources.push({
      kind: "project",
      path,
      reason: isTrusted() ? undefined : UNTRUSTED_REASON,
    });
  }
  return sources;
}

const sourceTitle = (kind: SourceKind): string =>
  kind === "global" ? "# 笔记" : "# 项目笔记";

function renderSource(
  source: Pick<SourceSnapshot, "notes" | "folders">,
): string {
  const parts: string[] = [];
  const full = source.notes.filter((note) => note.body !== undefined);
  const summaries = source.notes.filter((note) => note.body === undefined);
  if (full.length) parts.push("## 已展开笔记", ...full.map(renderNote));
  if (summaries.length)
    parts.push("## 按需阅读", summaries.map(renderNote).join("\n\n"));
  if (source.folders.length)
    parts.push(
      "## 文件夹",
      source.folders
        .map((folder) => `- ${folder.name}：${folder.path}`)
        .join("\n"),
    );
  if (!source.notes.length && !source.folders.length)
    parts.push("此目录暂无可提供的根笔记或子文件夹。");
  return parts.join("\n\n");
}

/** Injected blocks only; excluded sources are never sent to the model. */
export function formatSnapshot(snapshot: Snapshot): string {
  return snapshot.sources
    .filter((source) => source.text)
    .map((source) => source.text)
    .join("\n\n");
}

/** /notes preview: injected blocks plus every excluded source with its reason. */
export function previewSnapshot(snapshot: Snapshot): string {
  const injected = formatSnapshot(snapshot);
  const skipped = snapshot.sources.filter((source) => source.skipped);
  return [
    ...(injected ? [injected] : []),
    ...(skipped.length
      ? [
          "## 未注入来源",
          ...skipped.map(
            (source) =>
              `- ${source.kind === "global" ? "全局" : "项目"} ${
                source.path
              }：${source.skipped}`,
          ),
        ]
      : []),
    ...(snapshot.issues.length
      ? [
          "## 读取与索引提醒",
          snapshot.issues.map((issue) => `- ${issue}`).join("\n"),
        ]
      : []),
  ].join("\n\n");
}

export async function readHeader(
  file: FileHandle,
  size: bigint,
): Promise<ReturnType<typeof parseMetadata>> {
  const chunks: Buffer[] = [];
  let length = 0;
  while (length < MAX_HEADER_BYTES) {
    const chunk = Buffer.alloc(Math.min(4096, MAX_HEADER_BYTES - length));
    const result = await file.read(chunk, 0, chunk.length, length);
    chunks.push(chunk.subarray(0, result.bytesRead));
    length += result.bytesRead;
    const bounds = headerBounds(
      Buffer.concat(chunks).toString("utf8"),
      result.bytesRead === 0 || BigInt(length) >= size,
    );
    if (bounds) return parseMetadata(bounds.source);
  }
  throw new Error(`frontmatter 超过 ${MAX_HEADER_BYTES / 1024} KiB`);
}

async function readBody(
  file: FileHandle,
  stat: BigIntStats,
  limit: number,
): Promise<string> {
  if (stat.size > BigInt(limit))
    throw new Error(
      `文件超过本轮 ${
        limit / 1024
      } KiB 注入上限，请拆分笔记或调整 maxContextBytes`,
    );
  const buffer = Buffer.alloc(Number(stat.size) + 1);
  let length = 0;
  while (length < buffer.length) {
    const result = await file.read(
      buffer,
      length,
      buffer.length - length,
      length,
    );
    if (!result.bytesRead) break;
    length += result.bytesRead;
  }
  if (length > Number(stat.size))
    throw new Error("读取期间文件发生变化，请下一轮重试");
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(buffer.subarray(0, length));
  const bounds = headerBounds(text, true)!;
  return text.slice(bounds.bodyOffset);
}

/** Only root entries are discovered. Serialized cache payload is capped at twice the context budget. */
export class NotesLoader {
  private cache = new Map<
    string,
    { signature: string; note: Note; bytes: number }
  >();
  private cacheBytes = 0;
  private limit?: number;

  clear(): void {
    this.cache.clear();
    this.cacheBytes = 0;
  }

  private remember(path: string, key: string, note: Note, limit: number): void {
    const previous = this.cache.get(path);
    if (previous) this.cacheBytes -= previous.bytes;
    this.cache.delete(path);
    const cost = bytes(JSON.stringify(note)) + key.length;
    this.cache.set(path, { signature: key, note, bytes: cost });
    this.cacheBytes += cost;
    while (this.cacheBytes > limit && this.cache.size) {
      const oldest = this.cache.keys().next().value!;
      this.cacheBytes -= this.cache.get(oldest)!.bytes;
      this.cache.delete(oldest);
    }
  }

  /** Scan one source's direct children. Throws when the source itself is unreadable. */
  private async scanEntries(
    directory: string,
    seen: Set<string>,
    limit: number,
  ): Promise<Collected> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    const collected: Collected = {
      notes: [],
      folders: [],
      issues: [],
      reads: 0,
      cacheHits: 0,
    };
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      if (/[\x00-\x1f\x7f]/.test(entry.name)) {
        collected.issues.push(
          `跳过含控制字符的名称：${JSON.stringify(entry.name)}`,
        );
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        collected.folders.push({ name: entry.name, path });
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md"))
        continue;
      seen.add(path);
      let note: Note = { name: entry.name, path };
      let file: FileHandle | undefined;
      try {
        const stat = await lstat(path, { bigint: true });
        if (!stat.isFile()) throw new Error("文件类型已改变，本轮仅提供路径");
        const cached = this.cache.get(path);
        if (cached?.signature === signature(stat)) {
          note = cached.note;
          collected.cacheHits++;
        } else {
          file = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          const before = await file.stat({ bigint: true });
          if (!before.isFile()) throw new Error("仅自动读取普通 Markdown 文件");
          collected.reads++;
          const metadata = await readHeader(file, before.size);
          note = {
            ...note,
            purpose: metadata.purpose,
            description: metadata.description,
          };
          if (metadata.defaultopen)
            note.body = await readBody(file, before, limit);
          if (
            signature(before) !== signature(await file.stat({ bigint: true }))
          )
            throw new Error("读取期间文件发生变化，请下一轮重试");
          this.remember(path, signature(before), note, limit * 2);
        }
      } catch (error) {
        // Keep a useful path, but never inject an unvalidated/partial body or metadata.
        note = {
          name: entry.name,
          path,
          error: errorMessage(error).split("\n")[0],
        };
      } finally {
        await file?.close();
      }
      collected.notes.push(note);
      if (note.error) collected.issues.push(`${note.name}：${note.error}`);
    }
    return collected;
  }

  /**
   * Sources are ordered by the caller (global first, project shallow to deep).
   * Whole sources exceeding the budget are excluded and reported; no partial
   * note bodies are injected and nothing is silently dropped.
   */
  async scan(
    config: NotesConfig,
    sources: SourceRequest[] = [],
  ): Promise<Snapshot> {
    const { directory, maxContextBytes } = config;
    if (!sources.length)
      sources = directory ? [{ kind: "global", path: directory }] : [];
    if (maxContextBytes !== this.limit) this.clear();
    this.limit = maxContextBytes;
    const snapshot: Snapshot = {
      directory,
      sources: [],
      issues: [],
      text: "",
      bytes: 0,
      reads: 0,
      cacheHits: 0,
    };
    const seen = new Set<string>();
    const blocks: string[] = [];
    let used = 0;
    for (const source of sources) {
      if (source.reason) {
        snapshot.sources.push({
          kind: source.kind,
          path: source.path,
          notes: [],
          folders: [],
          issues: [],
          text: "",
          bytes: 0,
          skipped: source.reason,
        });
        continue;
      }
      let collected: Collected;
      let identity: string;
      try {
        const root = await stat(source.path, { bigint: true });
        identity = `${root.dev}:${root.ino}`;
        collected = await this.scanEntries(source.path, seen, maxContextBytes);
      } catch (error) {
        const problem = errorMessage(error);
        snapshot.issues.push(`${source.path}：${problem}`);
        snapshot.sources.push({
          kind: source.kind,
          path: source.path,
          notes: [],
          folders: [],
          issues: [],
          text: "",
          bytes: 0,
          skipped: problem,
        });
        continue;
      }
      snapshot.reads += collected.reads;
      snapshot.cacheHits += collected.cacheHits;
      snapshot.issues.push(
        ...collected.issues.map((issue) =>
          source.kind === "global" ? issue : `${source.path}/${issue}`,
        ),
      );
      const text = `${sourceTitle(source.kind)}\n\n${renderSource(collected)}`;
      const cost = bytes(text);
      const separator = blocks.length ? 2 : 0;
      if (used + separator + cost > maxContextBytes) {
        const reason = `默认上下文超过 ${
          maxContextBytes / 1024
        } KiB，该来源本轮未注入。请缩小目录、关闭部分 defaultopen，或调整 notes.json 的 maxContextBytes。`;
        snapshot.issues.push(`${source.path}：${reason}`);
        snapshot.sources.push({
          kind: source.kind,
          path: source.path,
          notes: [],
          folders: [],
          issues: collected.issues,
          text: "",
          bytes: 0,
          skipped: reason,
        });
        continue;
      }
      used += separator + cost;
      blocks.push(text);
      snapshot.sources.push({
        kind: source.kind,
        path: source.path,
        identity,
        notes: collected.notes,
        folders: collected.folders,
        issues: collected.issues,
        text,
        bytes: cost,
      });
    }
    for (const [path, cached] of this.cache) {
      if (!seen.has(path)) {
        this.cacheBytes -= cached.bytes;
        this.cache.delete(path);
      }
    }
    snapshot.text = blocks.join("\n\n");
    snapshot.bytes = bytes(snapshot.text);
    return snapshot;
  }
}

interface Collected {
  notes: Note[];
  folders: Folder[];
  issues: string[];
  reads: number;
  cacheHits: number;
}

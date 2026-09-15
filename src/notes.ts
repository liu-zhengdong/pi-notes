import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { errorMessage, type NotesConfig } from "./config.ts";

export const MAX_HEADER_BYTES = 64 * 1024;
export interface Metadata {
  defaultopen: boolean;
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
export interface Snapshot {
  directory: string;
  notes: Note[];
  folders: { name: string; path: string }[];
  issues: string[];
  text: string;
  bytes: number;
  reads: number;
  cacheHits: number;
}

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
  const data: unknown = document.toJS({ maxAliasCount: 0 }) ?? {};
  if (typeof data !== "object" || Array.isArray(data))
    throw new Error("frontmatter 必须是字段映射");
  const fields = data as Record<string, unknown>;
  const defaultopen = Object.hasOwn(fields, "defaultopen")
    ? fields.defaultopen
    : false;
  if (typeof defaultopen !== "boolean")
    throw new Error("defaultopen 必须是布尔值 true 或 false（不能加引号）");
  const result: Metadata = { defaultopen };
  for (const key of ["description", "purpose"] as const) {
    const value = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (value == null) continue;
    if (typeof value !== "string") throw new Error(`${key} 必须是文本`);
    if (value.trim()) result[key] = value.trim();
  }
  return result;
}

const signature = (stat: BigIntStats): string =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const field = (label: string, value: string, indent = ""): string =>
  `${indent}${label}：${value.replace(/\r?\n/g, `\n${indent}  `)}`;

function renderNote(note: Note): string {
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

const contextHeader = (directory: string): string =>
  [
    "# 笔记",
    field("目录", directory),
    "按需读取笔记全文、浏览子文件夹，或使用可用的搜索工具查找内容。",
  ].join("\n\n");

export function formatSnapshot(
  snapshot: Pick<Snapshot, "directory" | "notes" | "folders">,
): string {
  const parts = [contextHeader(snapshot.directory)];
  const full = snapshot.notes.filter((note) => note.body !== undefined);
  const summaries = snapshot.notes.filter((note) => note.body === undefined);
  if (full.length) parts.push("## 已展开笔记", ...full.map(renderNote));
  if (summaries.length)
    parts.push("## 按需阅读", summaries.map(renderNote).join("\n\n"));
  if (snapshot.folders.length)
    parts.push(
      "## 文件夹",
      snapshot.folders
        .map((folder) => `- ${folder.name}：${folder.path}`)
        .join("\n"),
    );
  if (!snapshot.notes.length && !snapshot.folders.length)
    parts.push("此目录暂无可提供的根笔记或子文件夹。");
  return parts.join("\n\n");
}

async function readHeader(
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
      `文件超过本轮 ${limit / 1024} KiB 注入上限，请拆分笔记或调整 maxContextBytes`,
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
  private directory?: string;
  private limit?: number;

  clear(): void {
    this.cache.clear();
    this.cacheBytes = 0;
    this.directory = undefined;
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

  async scan(config: NotesConfig): Promise<Snapshot> {
    const { directory, maxContextBytes } = config;
    if (!directory) throw new Error("尚未配置笔记目录");
    if (directory !== this.directory || maxContextBytes !== this.limit)
      this.clear();
    this.directory = directory;
    this.limit = maxContextBytes;
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    const snapshot: Snapshot = {
      directory,
      notes: [],
      folders: [],
      issues: [],
      text: "",
      bytes: 0,
      reads: 0,
      cacheHits: 0,
    };
    const seen = new Set<string>();
    // Count each section and entry once; avoid repeatedly assembling the growing context.
    let contextBytes = bytes(contextHeader(directory));
    const noteSections = new Set<string>();
    const checkBudget = (): void => {
      if (contextBytes > maxContextBytes)
        throw new Error(
          `默认上下文超过 ${maxContextBytes / 1024} KiB，本轮未注入笔记。请缩小目录、关闭部分 defaultopen，或调整 notes.json 的 maxContextBytes。`,
        );
    };
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      if (/[\x00-\x1f\x7f]/.test(entry.name)) {
        snapshot.issues.push(
          `跳过含控制字符的名称：${JSON.stringify(entry.name)}`,
        );
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot.folders.push({ name: entry.name, path });
        contextBytes += bytes(
          `${snapshot.folders.length === 1 ? "\n\n## 文件夹\n\n" : "\n"}- ${entry.name}：${path}`,
        );
        checkBudget();
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
          snapshot.cacheHits++;
        } else {
          file = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          const before = await file.stat({ bigint: true });
          if (!before.isFile()) throw new Error("仅自动读取普通 Markdown 文件");
          snapshot.reads++;
          const metadata = await readHeader(file, before.size);
          note = {
            ...note,
            purpose: metadata.purpose,
            description: metadata.description,
          };
          if (metadata.defaultopen)
            note.body = await readBody(file, before, maxContextBytes);
          if (
            signature(before) !== signature(await file.stat({ bigint: true }))
          )
            throw new Error("读取期间文件发生变化，请下一轮重试");
          this.remember(path, signature(before), note, maxContextBytes * 2);
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
      snapshot.notes.push(note);
      if (note.error) snapshot.issues.push(`${note.name}：${note.error}`);
      const section = note.body === undefined ? "## 按需阅读" : "## 已展开笔记";
      if (!noteSections.has(section)) {
        noteSections.add(section);
        contextBytes += bytes(`\n\n${section}`);
      }
      contextBytes += bytes(`\n\n${renderNote(note)}`);
      checkBudget();
    }
    for (const [path, cached] of this.cache) {
      if (!seen.has(path)) {
        this.cacheBytes -= cached.bytes;
        this.cache.delete(path);
      }
    }
    snapshot.text = formatSnapshot(snapshot);
    snapshot.bytes = bytes(snapshot.text);
    if (snapshot.bytes > maxContextBytes) {
      contextBytes = snapshot.bytes;
      checkBudget();
    }
    return snapshot;
  }
}

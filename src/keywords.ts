import { constants } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { errorMessage } from "./config.ts";
import { readHeader, signature, type Note, type Snapshot } from "./notes.ts";

export interface KeywordNote extends Note {
  keywords: string[];
}

// Include negative lookups in the cache: most notes need no reminder.
export const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
interface Cached {
  signature: string;
  note?: KeywordNote;
  error?: string;
  bytes: number;
}

/** Metadata-only, bounded index. No file I/O occurs while matching a message. */
export class KeywordIndex {
  notes = new Map<string, KeywordNote>();
  issues: string[] = [];
  reads = 0;
  cacheHits = 0;
  private cache = new Map<string, Cached>();
  private cacheBytes = 0;

  clear(): void {
    this.notes.clear();
    this.cache.clear();
    this.cacheBytes = 0;
    this.issues = [];
  }

  private remember(path: string, value: Omit<Cached, "bytes">): void {
    const previous = this.cache.get(path);
    if (previous) this.cacheBytes -= previous.bytes;
    this.cache.delete(path);
    const bytes =
      Buffer.byteLength(path) + Buffer.byteLength(JSON.stringify(value));
    this.cache.set(path, { ...value, bytes });
    this.cacheBytes += bytes;
    while (this.cacheBytes > MAX_INDEX_BYTES && this.cache.size) {
      const oldest = this.cache.keys().next().value!;
      this.cacheBytes -= this.cache.get(oldest)!.bytes;
      this.cache.delete(oldest);
    }
  }

  /** Disk cache contains only bounded, validated metadata. Never accept cached bodies. */
  exportCache(): unknown {
    return [...this.cache].map(([path, { signature, note, error }]) => ({
      path,
      signature,
      note,
      error,
    }));
  }

  importCache(data: unknown, directory: string): void {
    if (!Array.isArray(data) || data.length > MAX_ENTRIES)
      throw new Error("无效的关键词缓存");
    const parsed = new KeywordIndex();
    for (const item of data) {
      if (!item || typeof item !== "object")
        throw new Error("无效的关键词缓存条目");
      const { path, signature: key, note, error } = item;
      if (
        typeof path !== "string" ||
        typeof key !== "string" ||
        !/^\d+:\d+:\d+:\d+:\d+$/.test(key)
      )
        throw new Error("无效的关键词缓存标识");
      const rel = relative(directory, path);
      const parts = rel.split(sep);
      if (
        !isAbsolute(path) ||
        join(directory, rel) !== path ||
        isAbsolute(rel) ||
        parts.length < 2 ||
        parts.some(
          (p) => !p || p.startsWith(".") || /[\x00-\x1f\x7f]/.test(p),
        ) ||
        !path.toLowerCase().endsWith(".md")
      )
        throw new Error("关键词缓存路径越界");
      if (error !== undefined && typeof error !== "string")
        throw new Error("无效的缓存错误");
      if (
        note !== undefined &&
        (!note ||
          typeof note !== "object" ||
          note.path !== path ||
          note.name !== basename(path) ||
          "body" in note ||
          !Array.isArray(note.keywords) ||
          !note.keywords.length ||
          note.keywords.some(
            (word: unknown) =>
              typeof word !== "string" ||
              !word.trim() ||
              word !== word.trim().toLowerCase(),
          ) ||
          [note.description, note.purpose].some(
            (value) => value !== undefined && typeof value !== "string",
          ))
      )
        throw new Error("无效的缓存笔记");
      parsed.remember(path, {
        signature: key,
        error,
        note: note && {
          name: note.name,
          path,
          keywords: note.keywords,
          description: note.description,
          purpose: note.purpose,
        },
      });
    }
    this.cache = parsed.cache;
    this.cacheBytes = parsed.cacheBytes;
  }

  async refresh(
    snapshot: Snapshot,
    changes?: readonly string[],
  ): Promise<void> {
    // Reconcile only affected subtrees. Diagnostics/limits require a full retry.
    if (this.issues.length) changes = undefined;
    const within = (path: string, parent: string) =>
      path === parent || path.startsWith(parent + sep);
    const affected = (path: string) =>
      !changes || changes.some((change) => within(path, change));
    const traverse = (path: string) =>
      !changes ||
      changes.some((change) => within(path, change) || within(change, path));
    const notes = new Map([...this.notes].filter(([path]) => !affected(path)));
    this.issues = [];
    this.reads = this.cacheHits = 0;
    let issueCount = 0;
    const report = (issue: string): void => {
      issueCount++;
      if (this.issues.length < 100) this.issues.push(issue);
    };
    const seen = new Set<string>();
    const directories = new Set<string>();
    const roots = new Set(
      snapshot.sources
        .filter((source) => source.text)
        .flatMap((source) => source.notes.map((note) => note.path)),
    );
    const stack = snapshot.sources
      .filter((source) => source.text)
      .flatMap((source) => source.folders.map((folder) => folder.path))
      .reverse();
    let entriesSeen = 0;
    let indexBytes = [...notes.values()].reduce(
      (sum, note) => sum + Buffer.byteLength(JSON.stringify(note)),
      0,
    );
    let omitted = 0;
    while (stack.length) {
      const directory = stack.pop()!;
      if (directories.has(directory) || !traverse(directory)) continue;
      directories.add(directory);
      try {
        // Sources have already passed policy. Descendant symlinks remain excluded.
        if (!(await lstat(directory)).isDirectory()) continue;
        const entries = (
          await readdir(directory, { withFileTypes: true })
        ).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const children: string[] = [];
        for (const entry of entries) {
          if (++entriesSeen > MAX_ENTRIES) break;
          if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
          if (/[\x00-\x1f\x7f]/.test(entry.name)) {
            report(
              `关键词索引跳过含控制字符的名称：${JSON.stringify(entry.name)}`,
            );
            continue;
          }
          const path = join(directory, entry.name);
          if (!traverse(path)) continue;
          if (entry.isDirectory()) {
            children.push(path);
            continue;
          }
          if (
            !entry.isFile() ||
            !entry.name.toLowerCase().endsWith(".md") ||
            roots.has(path) ||
            seen.has(path)
          )
            continue;
          seen.add(path);
          let file: FileHandle | undefined;
          try {
            const stat = await lstat(path, { bigint: true });
            if (!stat.isFile()) continue;
            const key = signature(stat);
            const cached = this.cache.get(path);
            let note: KeywordNote | undefined;
            if (cached?.signature === key) {
              this.cacheHits++;
              if (cached.error) throw new Error(cached.error);
              note = cached.note;
            } else {
              file = await open(
                path,
                constants.O_RDONLY |
                  constants.O_NOFOLLOW |
                  constants.O_NONBLOCK,
              );
              const before = await file.stat({ bigint: true });
              if (!before.isFile()) throw new Error("仅索引普通 Markdown 文件");
              this.reads++;
              const metadata = await readHeader(file, before.size).catch(
                async (error) => {
                  // Cache parse failures, not transient file-system errors.
                  if (
                    !(error && typeof error === "object" && "code" in error) &&
                    signature(before) ===
                      signature(await file!.stat({ bigint: true }))
                  )
                    this.remember(path, {
                      signature: signature(before),
                      error: errorMessage(error).split("\n")[0],
                    });
                  throw error;
                },
              );
              if (metadata.keywords?.length)
                note = {
                  name: entry.name,
                  path,
                  keywords: metadata.keywords,
                  description: metadata.description,
                  purpose: metadata.purpose,
                };
              if (
                signature(before) !==
                signature(await file.stat({ bigint: true }))
              )
                throw new Error("读取期间文件发生变化，请下一轮重试");
              this.remember(path, { signature: signature(before), note });
            }
            if (note) {
              const cost = Buffer.byteLength(JSON.stringify(note));
              if (indexBytes + cost > MAX_INDEX_BYTES) omitted++;
              else {
                indexBytes += cost;
                notes.set(path, note);
              }
            }
          } catch (error) {
            report(`${path}：${errorMessage(error).split("\n")[0]}`);
          } finally {
            await file?.close();
          }
        }
        if (entriesSeen > MAX_ENTRIES) {
          report(
            `关键词索引达到 ${MAX_ENTRIES} 条目扫描上限；其余条目未索引。请缩小笔记目录。`,
          );
          break;
        }
        stack.push(...children.reverse());
      } catch (error) {
        report(`${directory}：${errorMessage(error).split("\n")[0]}`);
      }
    }
    if (omitted)
      report(`关键词索引达到 16 MiB 上限，${omitted} 篇笔记未索引。`);
    if (issueCount > this.issues.length)
      this.issues.push(
        `另有 ${issueCount - this.issues.length} 项索引提醒未展开。`,
      );
    for (const [path, cached] of this.cache) {
      if (affected(path) && !seen.has(path)) {
        this.cacheBytes -= cached.bytes;
        this.cache.delete(path);
      }
    }
    // Publish atomically; readers never see a half-built index.
    this.notes = new Map(
      [...notes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }

  match(text: string): string[] {
    if (!text || !this.notes.size) return [];
    const normalized = text.toLowerCase();
    const matches: string[] = [];
    for (const note of this.notes.values()) {
      if (note.keywords.some((word) => normalized.includes(word)))
        matches.push(note.path);
    }
    return matches;
  }
}

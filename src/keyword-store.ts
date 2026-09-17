import { createHash, randomUUID } from "node:crypto";
import { constants, watch, type FSWatcher } from "node:fs";
import { mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { errorMessage } from "./config.ts";
import { KeywordIndex, MAX_INDEX_BYTES } from "./keywords.ts";
import type { Snapshot, SourceSnapshot } from "./notes.ts";

interface Source {
  root: string;
  identity?: string;
  index: KeywordIndex;
  watcher?: FSWatcher;
  timer?: ReturnType<typeof setTimeout>;
  saveTimer?: ReturnType<typeof setTimeout>;
  job?: Promise<void>;
  saving?: Promise<void>;
  changed: Set<string>;
  full: boolean;
  loaded: boolean;
  closed: boolean;
  digest?: string;
  issues: Partial<Record<"watch" | "load" | "refresh" | "save", string>>;
  lastScan: number;
}
const MAX_CACHE_FILE = 20 * 1024 * 1024;
const FALLBACK_INTERVAL = 30_000;
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** Per-source caches outlive conversations; the public index is a request snapshot. */
export class KeywordStore {
  readonly index = new KeywordIndex();
  private sources = new Map<string, Source>();
  private retiring = new Set<Promise<void>>();
  private selected: SourceSnapshot[] = [];
  private fallback?: ReturnType<typeof setInterval>;
  private stopped = false;
  private publishedKey = "";
  private publishGeneration = 0;
  refreshes = 0;

  private cacheDirectory: string;

  constructor(cacheDirectory: string) {
    this.cacheDirectory = cacheDirectory;
  }

  /** Fast selection only. All recursive I/O runs in background, never on submit. */
  prepare(snapshot: Snapshot): void {
    this.stopped = false;
    this.selected = snapshot.sources.filter((source) => source.text);
    const roots = new Set(this.selected.map((source) => source.path));
    for (const [root, state] of this.sources) {
      if (roots.has(root)) continue;
      this.retire(state);
      const retiring = (state.job ?? Promise.resolve()).then(() =>
        this.save(state),
      );
      this.retiring.add(retiring);
      void retiring.finally(() => this.retiring.delete(retiring));
      this.sources.delete(root);
    }
    for (const source of this.selected) {
      const root = source.path;
      let state = this.sources.get(root);
      if (!state) {
        state = {
          root,
          identity: source.identity,
          index: new KeywordIndex(),
          changed: new Set(),
          full: true,
          loaded: false,
          closed: false,
          issues: {},
          lastScan: 0,
        };
        this.sources.set(root, state);
        this.observe(state);
        this.launch(state);
      } else if (state.closed || state.identity !== source.identity) {
        state.identity = source.identity;
        state.watcher?.close();
        state.watcher = undefined;
        state.closed = false;
        state.full = true; // Files could have changed while the watcher was closed.
        this.observe(state);
        this.launch(state);
      }
    }
    if (!this.fallback) {
      // Watch errors/unavailable platforms degrade to background reconciliation.
      this.fallback = setInterval(() => {
        for (const state of this.sources.values()) {
          if (
            !state.watcher &&
            Date.now() - state.lastScan >= FALLBACK_INTERVAL
          ) {
            this.observe(state);
            state.full = true;
            this.launch(state);
          }
        }
      }, FALLBACK_INTERVAL);
      this.fallback.unref();
    }
  }

  reset(): void {
    this.prepare({
      directory: null,
      sources: [],
      text: "",
      bytes: 0,
      issues: [],
      reads: 0,
      cacheHits: 0,
    });
    this.publishGeneration++;
    this.index.clear();
    this.publishedKey = "";
  }

  get stats(): { refreshes: number; reads: number; cacheHits: number } {
    const states = [...this.sources.values()];
    return {
      refreshes: this.refreshes,
      reads: states.reduce((n, s) => n + s.index.reads, 0),
      cacheHits: states.reduce((n, s) => n + s.index.cacheHits, 0),
    };
  }

  get pending(): boolean {
    return [...this.sources.values()].some(
      (state) => !!state.job || state.full || state.changed.size > 0,
    );
  }

  private observe(state: Source): void {
    try {
      state.watcher = watch(
        state.root,
        { recursive: true, persistent: false },
        (_event, name) => {
          const parts = name?.toString().split(/[\\/]/);
          if (
            parts?.some(
              (part) => part.startsWith(".") || /[\x00-\x1f\x7f]/.test(part),
            )
          )
            return;
          if (!parts?.length || !parts.join("")) state.full = true;
          else {
            const path = resolve(state.root, ...parts);
            const prefix = state.root.endsWith(sep)
              ? state.root
              : state.root + sep;
            if (!path.startsWith(prefix)) return;
            if (state.changed.size < 1000) state.changed.add(path);
            else {
              state.changed.clear();
              state.full = true;
            }
          }
          clearTimeout(state.timer);
          state.timer = setTimeout(() => this.launch(state), 40);
          state.timer.unref();
        },
      );
      state.watcher.on("error", (error) => {
        state.watcher?.close();
        state.watcher = undefined;
        state.issues.watch = `关键词文件监听不可用，改为后台定期检查：${errorMessage(
          error,
        )}`;
        state.full = true;
        this.launch(state);
      });
      delete state.issues.watch;
    } catch (error) {
      state.issues.watch = `关键词文件监听不可用，改为后台定期检查：${errorMessage(
        error,
      )}`;
    }
  }

  private cachePath(root: string): string {
    return join(this.cacheDirectory, `${digest(root)}.json`);
  }

  private async load(state: Source): Promise<void> {
    let file;
    try {
      file = await open(
        this.cachePath(state.root),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_CACHE_FILE)
        throw new Error("缓存类型或大小无效");
      const buffer = Buffer.alloc(stat.size + 1);
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
      if (length !== stat.size) throw new Error("读取期间缓存变化");
      const text = buffer.subarray(0, length).toString("utf8");
      const data: unknown = JSON.parse(text);
      if (
        !data ||
        typeof data !== "object" ||
        !("version" in data) ||
        data.version !== 1 ||
        !("root" in data) ||
        data.root !== state.root ||
        !("entries" in data)
      )
        throw new Error("缓存版本或来源无效");
      state.index.importCache(data.entries, state.root);
      state.digest = digest(text);
      delete state.issues.load;
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        state.issues.load = `关键词缓存不可用，已改为重新索引：${errorMessage(
          error,
        )}`;
      else delete state.issues.load;
    } finally {
      await file?.close();
    }
  }

  private launch(state: Source): void {
    clearTimeout(state.timer);
    if (state.closed || state.job || (!state.full && !state.changed.size))
      return;
    state.job = this.refresh(state)
      .catch((error) => {
        state.index.clear(); // A failed source must not keep stale candidates.
        this.refreshes++;
        state.lastScan = Date.now();
        state.watcher?.close();
        state.watcher = undefined;
        state.issues.refresh = `关键词索引失败：${errorMessage(error)}`;
      })
      .finally(() => {
        state.job = undefined;
        if (!state.closed && (state.full || state.changed.size))
          this.launch(state);
      });
  }

  private async refresh(state: Source): Promise<void> {
    if (!state.loaded) {
      await this.load(state);
      state.loaded = true;
    }
    const changes = state.full ? undefined : [...state.changed];
    state.full = false;
    state.changed.clear();
    // Re-read only root folders, so directory creation/deletion is represented.
    const entries = await readdir(state.root, { withFileTypes: true });
    const folders = entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          !entry.name.startsWith(".") &&
          !/[\x00-\x1f\x7f]/.test(entry.name),
      )
      .map((entry) => ({
        name: entry.name,
        path: join(state.root, entry.name),
      }));
    const source: SourceSnapshot = {
      kind: "global",
      path: state.root,
      notes: [],
      folders,
      issues: [],
      text: "selected",
      bytes: 0,
    };
    await state.index.refresh(
      {
        directory: state.root,
        sources: [source],
        text: "",
        bytes: 0,
        issues: [],
        reads: 0,
        cacheHits: 0,
      },
      changes,
    );
    delete state.issues.refresh;
    this.refreshes++;
    state.lastScan = Date.now();
    clearTimeout(state.saveTimer);
    if (!state.closed) {
      state.saveTimer = setTimeout(() => {
        void this.save(state);
      }, 1000);
      state.saveTimer.unref();
    }
  }

  private save(state: Source): Promise<void> {
    // Serialize writes per source; atomic rename also tolerates concurrent Pi processes.
    const job = (state.saving ?? Promise.resolve())
      .then(async () => {
        if (!state.loaded || !state.lastScan) return;
        const text = JSON.stringify({
          version: 1,
          root: state.root,
          entries: state.index.exportCache(),
        });
        const hash = digest(text);
        if (hash === state.digest) {
          // The current content is already persisted; no unsaved changes remain.
          delete state.issues.save;
          return;
        }
        await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
        const path = this.cachePath(state.root);
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
        state.digest = hash;
        delete state.issues.save;
        // Atomic replacement also repairs a cache rejected during startup.
        delete state.issues.load;
      })
      .catch((error) => {
        state.issues.save = `关键词缓存未保存：${errorMessage(error)}`;
      });
    state.saving = job;
    return job;
  }

  /** First request waits here (after the user's message is visible), only if needed.
   * Later tool continuations retain this same immutable request index. */
  async publish(): Promise<void> {
    const generation = ++this.publishGeneration;
    // Let queued fs.watch notifications run before taking the request snapshot.
    await new Promise<void>((done) => setImmediate(done));
    for (const state of this.sources.values()) {
      this.launch(state);
      // Include a change that arrived during the current scan without letting
      // continuous filesystem writes postpone a model request indefinitely.
      const first = state.job;
      await first;
      if (state.job && state.job !== first) await state.job;
    }
    if (this.stopped || generation !== this.publishGeneration) return;
    const key = JSON.stringify([
      this.refreshes,
      this.selected.map((source) => [
        source.path,
        source.notes.map((note) => note.path),
      ]),
      [...this.sources.values()].map((state) => state.issues),
    ]);
    if (key === this.publishedKey) return;
    const notes = new Map<string, import("./keywords.ts").KeywordNote>();
    const issues: string[] = [];
    const roots = new Set(
      this.selected.flatMap((source) => source.notes.map((note) => note.path)),
    );
    let bytes = 0;
    for (const source of this.selected) {
      const state = this.sources.get(source.path);
      if (!state) continue;
      for (const issue of Object.values(state.issues))
        issues.push(`${source.path}：${issue}`);
      issues.push(...state.index.issues);
      for (const [path, note] of state.index.notes) {
        if (roots.has(path) || notes.has(path)) continue;
        bytes += Buffer.byteLength(JSON.stringify(note));
        if (bytes > MAX_INDEX_BYTES) {
          issues.push("关键词索引达到 16 MiB 合并上限，其余笔记未加入。");
          break;
        }
        notes.set(path, note);
      }
    }
    this.index.notes = notes;
    this.index.issues = issues.slice(0, 100);
    this.publishedKey = key;
  }

  private retire(state: Source): void {
    state.closed = true;
    state.watcher?.close();
    state.watcher = undefined;
    clearTimeout(state.timer);
    clearTimeout(state.saveTimer);
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.fallback);
    this.fallback = undefined;
    for (const state of this.sources.values()) this.retire(state);
    await Promise.all(this.retiring);
    await Promise.all(
      [...this.sources.values()].map(async (state) => {
        await state.job;
        await this.save(state);
        clearTimeout(state.saveTimer);
      }),
    );
  }
}

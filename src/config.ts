import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const DEFAULT_MAX_CONTEXT_BYTES = 256 * 1024;
export interface NotesConfig {
  directory: string | null;
  maxContextBytes: number;
}

/** Unconfigured global notes live next to notes.json: `<agentDir>/notes`. */
export function defaultNotesDirectory(configPath: string): string {
  return join(dirname(configPath), "notes");
}

async function presentDefaultDirectory(
  configPath: string,
): Promise<string | null> {
  const directory = defaultNotesDirectory(configPath);
  try {
    const real = await realpath(directory);
    await readdir(real);
    return real;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cleanPath(input: string, cwd: string): string {
  let value = input.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  if (!value || /[\x00-\x1f\x7f]/.test(value))
    throw new Error("请提供有效的目录路径。");
  if (value === "~") value = homedir();
  else if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
  return resolve(cwd, value);
}

export async function validateDirectory(
  input: string,
  cwd: string,
): Promise<string> {
  const directory = await realpath(cleanPath(input, cwd));
  await readdir(directory); // Validate that it is a readable directory before saving.
  return directory;
}

export async function loadConfig(path: string): Promise<NotesConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        directory: await presentDefaultDirectory(path),
        maxContextBytes: DEFAULT_MAX_CONTEXT_BYTES,
      };
    }
    throw error;
  }
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("配置必须是 JSON 对象");
    const record = data as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "directory" && key !== "maxContextBytes")
        throw new Error(`未知字段：${key}`);
    }
    let directory: string | null;
    if ("directory" in record) {
      directory = record.directory as string | null;
      if (
        directory !== null &&
        (typeof directory !== "string" ||
          !isAbsolute(directory) ||
          /[\x00-\x1f\x7f]/.test(directory))
      ) {
        throw new Error("directory 必须是绝对路径或 null");
      }
    } else {
      directory = await presentDefaultDirectory(path);
    }
    const maxContextBytes = record.maxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES;
    if (
      typeof maxContextBytes !== "number" ||
      !Number.isSafeInteger(maxContextBytes) ||
      maxContextBytes < 1024 ||
      maxContextBytes > 16 * 1024 * 1024
    ) {
      throw new Error("maxContextBytes 必须是 1024 到 16777216 之间的整数");
    }
    return { directory, maxContextBytes };
  } catch (error) {
    throw new Error(`${path}：${errorMessage(error)}`);
  }
}

/** Atomic replacement; a bad config is never silently overwritten by a command. */
export async function saveDirectory(
  path: string,
  directory: string | null,
): Promise<void> {
  const current = await loadConfig(path);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ ...current, directory }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export type Event = Record<string, any>;
export class Rpc {
  process: ChildProcessWithoutNullStreams;
  events: Event[] = [];
  stderr = "";
  private listeners = new Set<() => void>();
  private nextId = 0;
  private protocolError?: Error;

  constructor(
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    rawDirectory: string,
  ) {
    this.process = spawn(
      process.env.PI_TEST_BIN ?? "pi",
      ["--mode", "rpc", ...args],
      { cwd, env, stdio: "pipe" },
    );
    let pending = "";
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => {
      appendFileSync(join(rawDirectory, "rpc.jsonl"), chunk);
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (!line) continue;
        try {
          this.events.push(JSON.parse(line));
        } catch {
          this.protocolError = new Error(
            `Non-JSON RPC output: ${line.slice(0, 300)}`,
          );
        }
      }
      for (const listener of this.listeners) listener();
    });
    this.process.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
      appendFileSync(join(rawDirectory, "stderr.txt"), chunk);
    });
    this.process.on("error", (error) => {
      this.protocolError = error;
      for (const listener of this.listeners) listener();
    });
  }

  async wait(
    predicate: (event: Event) => boolean,
    start = 0,
    timeout = 15000,
  ): Promise<Event> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.protocolError) {
          cleanup();
          reject(this.protocolError);
          return;
        }
        const event = this.events.slice(start).find(predicate);
        if (event) {
          cleanup();
          resolve(event);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`RPC timeout; stderr: ${this.stderr.slice(-2000)}`));
      }, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      this.listeners.add(check);
      check();
    });
  }

  async request(
    type: string,
    fields: Event = {},
    timeout?: number,
  ): Promise<Event> {
    const id = String(++this.nextId);
    const start = this.events.length;
    this.process.stdin.write(`${JSON.stringify({ type, id, ...fields })}\n`);
    const result = await this.wait(
      (event) => event.type === "response" && event.id === id,
      start,
      timeout,
    );
    if (!result.success) throw new Error(JSON.stringify(result));
    return result;
  }

  async prompt(message: string, timeout = 15000): Promise<void> {
    const start = this.events.length;
    await this.request("prompt", { message });
    await this.wait((event) => event.type === "agent_settled", start, timeout);
    const errors = this.events
      .slice(start)
      .filter(
        (event) =>
          event.type === "extension_error" ||
          (event.type === "message_end" &&
            event.message?.role === "assistant" &&
            ["error", "aborted"].includes(event.message.stopReason)),
      );
    if (errors.length) throw new Error(JSON.stringify(errors));
  }

  async close(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null)
      return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.process.kill("SIGKILL"), 3000);
      this.process.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.process.kill("SIGTERM");
    });
  }
}

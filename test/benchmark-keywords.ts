import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { KeywordIndex } from "../src/keywords.ts";
import { NotesLoader } from "../src/notes.ts";
import { DEFAULT_MAX_CONTEXT_BYTES } from "../src/config.ts";

const artifact = resolve(".artifacts", `keyword-benchmark-${Date.now()}`);
const work = join(artifact, "work");
const raw = join(artifact, "raw");
await mkdir(raw, { recursive: true });
const measure = async (directory: string) => {
  const index = new KeywordIndex();
  const loader = new NotesLoader();
  const config = { directory, maxContextBytes: DEFAULT_MAX_CONTEXT_BYTES };
  const rounds = [];
  for (const phase of ["cold", "warm"]) {
    const start = performance.now();
    const snapshot = await loader.scan(config);
    await index.refresh(snapshot);
    rounds.push({
      phase,
      ms: +(performance.now() - start).toFixed(2),
      reads: index.reads,
      hits: index.cacheHits,
      notes: index.notes.size,
      issues: index.issues.length,
      rssMiB: +(process.memoryUsage().rss / 1048576).toFixed(1),
    });
  }
  const text =
    "ordinary thinking and response text ".repeat(1024) + " keyword-0042-end";
  const start = performance.now();
  let matches = 0;
  for (let i = 0; i < 100; i++) matches += index.match(text).length;
  return {
    directory,
    rounds,
    matching: {
      messages: 100,
      charsEach: text.length,
      totalMs: +(performance.now() - start).toFixed(2),
      matches,
    },
  };
};
const results = [];
if (process.argv[2]) results.push(await measure(resolve(process.argv[2])));
// A deep library, not 10k default root summaries. 25% of files have keywords.
for (let folder = 0; folder < 100; folder++) {
  const path = join(work, "vault", String(folder).padStart(3, "0"));
  await mkdir(path, { recursive: true });
  await Promise.all(
    Array.from({ length: 100 }, (_, i) => {
      const id = folder * 100 + i;
      const text =
        id < 2500
          ? `---\nkeywords: [keyword-${String(id).padStart(4, "0")}-end, 字体-${id}]\ndescription: Representative summary ${id}.\n---\n`
          : "---\ndescription: No keyword configured.\n---\n";
      return writeFile(
        join(path, `${id}.md`),
        text + "Large body never loaded by keyword index.\n".repeat(20),
      );
    }),
  );
}
results.push(await measure(join(work, "vault")));
await writeFile(join(raw, "results.json"), JSON.stringify(results, null, 2));
// Read back the saved deliverable rather than only printing an in-memory object.
console.log(await readFile(join(raw, "results.json"), "utf8"));
console.log(`Evidence: ${artifact}`);

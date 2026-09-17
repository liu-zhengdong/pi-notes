import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotesLoader } from "../src/notes.ts";
import { DEFAULT_MAX_CONTEXT_BYTES } from "../src/config.ts";

const root = await mkdtemp(join(tmpdir(), "pi-notes-scale-"));
const nested = join(root, "archive");
const rootNotes = 1000;
const nestedNotes = 10000;
try {
  await mkdir(nested);
  // Bounded fixture creation concurrency; fixtures are not benchmark timings.
  for (let start = 0; start < nestedNotes; start += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, nestedNotes - start) }, (_, i) =>
        writeFile(join(nested, `${start + i}.md`), "nested content"),
      ),
    );
  }
  for (let start = 0; start < rootNotes; start += 50) {
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        writeFile(
          join(root, `${String(start + i).padStart(4, "0")}.md`),
          "---\ndescription: A reference note to read on demand.\npurpose: Background context.\ndefaultopen: false\n---\n" +
            "body".repeat(2048),
        ),
      ),
    );
  }
  const loader = new NotesLoader();
  const config = {
    directory: root,
    maxContextBytes: DEFAULT_MAX_CONTEXT_BYTES,
  };
  const scan = async () => {
    const begin = performance.now();
    const result = await loader.scan(config);
    return {
      ms: Number((performance.now() - begin).toFixed(2)),
      reads: result.reads,
      cacheHits: result.cacheHits,
      notes: result.sources.reduce(
        (count, source) => count + source.notes.length,
        0,
      ),
      folders: result.sources.reduce(
        (count, source) => count + source.folders.length,
        0,
      ),
      bytes: result.bytes,
    };
  };
  const cold = await scan();
  const warm = await scan();
  assert.equal(cold.reads, rootNotes);
  assert.equal(warm.reads, 0);
  assert.equal(warm.cacheHits, rootNotes);
  assert.equal(warm.folders, 1);
  await writeFile(
    join(root, "0000.md"),
    "---\ndescription: changed\n---\nbody",
  );
  const changed = await scan();
  assert.equal(changed.reads, 1);
  console.log(
    JSON.stringify(
      {
        rootNotes,
        nestedNotes,
        bodyBytesPerRootNote: 8192,
        cold,
        warm,
        changed,
        rssMiB: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

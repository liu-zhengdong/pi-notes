import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function observe(pi: ExtensionAPI): void {
  const directory = process.env.NOTES_OBSERVE_DIR;
  if (!directory) throw new Error("NOTES_OBSERVE_DIR is required");
  let requests = 0;
  pi.on("before_provider_request", (event, ctx) => {
    if (++requests > 8) {
      ctx.abort();
      throw new Error("Live smoke test exceeded 8 requests");
    }
    writeFileSync(
      join(directory, `request-${requests}.json`),
      JSON.stringify(event.payload),
    );
    writeFileSync(
      join(directory, "model.json"),
      JSON.stringify(
        {
          provider: ctx.model?.provider,
          model: ctx.model?.id,
          api: ctx.model?.api,
          baseUrl: ctx.model?.baseUrl,
          thinking: ctx.thinkingLevel,
        },
        null,
        2,
      ),
    );
  });
}

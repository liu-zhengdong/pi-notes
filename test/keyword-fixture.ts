import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fixtureProvider from "./fixture-provider.ts";

export default function keywordFixture(pi: ExtensionAPI): void {
  fixtureProvider(pi);
  pi.registerCommand("notes-test-origin", {
    description: "Test-only: branch exactly at the triggering assistant",
    handler: async (_args, ctx) => {
      const entry = ctx.sessionManager
        .getEntries()
        .find(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            JSON.stringify(entry.message.content).includes("final-key"),
        );
      if (!entry) throw new Error("Missing origin fixture");
      await ctx.navigateTree(entry.id, { summarize: false });
    },
  });
  pi.registerCommand("notes-test-boundary", {
    description:
      "Test-only: add a compaction boundary without starting the model",
    handler: async () => {
      pi.sendMessage(
        {
          customType: "notes-test-boundary",
          content: "Summary boundary.",
          display: false,
        },
        { triggerTurn: false },
      );
    },
  });
  pi.on("project_trust", () => ({
    trusted: process.env.NOTES_TEST_TRUST === "yes" ? "yes" : "no",
  }));
  // Deterministic real-host compaction: discard reminders, keep the last assistant.
  // This tests lifecycle/context reconstruction, not summary-model quality.
  pi.on("session_before_compact", (event) => {
    const last =
      event.customInstructions === "notes-test-drop-all"
        ? event.branchEntries.at(-1)
        : event.branchEntries.findLast(
            (entry) =>
              entry.type === "message" && entry.message.role === "assistant",
          );
    if (!last) return { cancel: true };
    return {
      compaction: {
        summary: "Earlier work was summarized.",
        firstKeptEntryId: last.id,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function fixtureProvider(pi: ExtensionAPI): void {
  if (!process.env.NOTES_TEST_URL)
    throw new Error(
      "NOTES_TEST_URL is required; test provider must stay local.",
    );
  const url = new URL(process.env.NOTES_TEST_URL);
  if (url.hostname !== "127.0.0.1")
    throw new Error("Fixture provider only permits loopback.");
  pi.registerProvider("notes-fixture", {
    baseUrl: url.href,
    apiKey: "local-test-only",
    api: "openai-completions",
    models: [
      {
        id: "fixture",
        name: "Notes Fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 128,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
}

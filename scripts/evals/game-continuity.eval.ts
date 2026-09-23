/** Opt-in live smoke eval, not a deterministic pass/fail test.
 * Run with the server tsx: ../../scripts/evals/game-continuity.eval.ts CONNECTION_ID [CASE_ID]
 * Uses a configured local subscription provider; never writes campaign data or invokes agents/tools.
 * Review each saved answer against criteria. Provider completion is not behavioral success.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { localAuthProviderBaseUrl } from "@marinara-engine/shared";
import {
  buildGmSystemPrompt,
  buildGmFormatReminder,
  buildGameRecencySeal,
  resolveGameAddressMode,
} from "../../packages/server/src/services/game/gm-prompts.js";
import { createLLMProvider } from "../../packages/server/src/services/llm/provider-registry.js";

const connectionId = process.argv[2];
if (!connectionId) throw new Error("Supply the configured local subscription connection ID; live calls consume usage.");
const response = await fetch(`http://127.0.0.1:7860/api/connections/${encodeURIComponent(connectionId)}`);
if (!response.ok) throw new Error(`Connection lookup failed: ${response.status}`);
const connection = await response.json();
const baseUrl = localAuthProviderBaseUrl(connection.provider);
if (!baseUrl) throw new Error("Only local subscription providers are supported; no API keys are read by this eval.");
const provider = createLLMProvider(
  connection.provider,
  baseUrl,
  "",
  connection.maxContext,
  null,
  connection.maxTokensOverride,
  connection.claudeFastMode === "true",
  false,
  connection.defaultParameters,
  connectionId,
);
const cases = JSON.parse(await readFile(new URL("./game-continuity.cases.json", import.meta.url), "utf8")) as Array<{
  id: string;
  context: string;
  input: string;
  criteria: string[];
}>;
const selected = cases.filter((item) => !process.argv[3] || item.id === process.argv[3]);
if (!selected.length) throw new Error("Unknown case ID");
const outputDir = resolve(".tmp", `game-continuity-eval-${Date.now()}`);
await mkdir(outputDir, { recursive: true });
for (const item of selected) {
  const ctx = {
    gameActiveState: "dialogue" as const,
    storyArc: null,
    plotTwists: null,
    map: null,
    npcs: [],
    sessionSummaries: [],
    sessionNumber: 7,
    partyNames: [],
    partyCards: [],
    playerName: "Lord Rowan",
    playerCard: "Lord Rowan is powerful, generous and protective. The user controls his choices and interiority.",
    gmCharacterCard: null,
    difficulty: "normal",
    genre: "fantasy",
    setting: "an original feudal kingdom",
    tone: "immersive",
    rating: "sfw" as const,
  };
  const messages = [
    { role: "system" as const, content: buildGmSystemPrompt(ctx) + "\n\nFixture facts:\n" + item.context },
    {
      role: "system" as const,
      content: buildGmFormatReminder({ ...ctx, addressMode: resolveGameAddressMode(item.input) }),
    },
    { role: "system" as const, content: buildGameRecencySeal(ctx.playerName) },
    { role: "user" as const, content: item.input },
  ];
  const result = {
    ...item,
    provider: connection.provider,
    model: connection.model,
    messages,
    answer: "",
    error: null as string | null,
  };
  process.stdout.write(`Running ${item.id} with ${connection.model}\n`);
  try {
    for await (const chunk of provider.chat(messages, {
      model: connection.model,
      maxTokens: 6000,
      stream: true,
      signal: AbortSignal.timeout(180_000),
    }))
      result.answer += chunk;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  await writeFile(resolve(outputDir, `${item.id}.json`), JSON.stringify(result, null, 2));
  process.stdout.write(
    `${item.id}: ${result.error ?? `${result.answer.split(/\n\s*\n/u).filter(Boolean).length} paragraphs; manual review required`}\n`,
  );
  if (result.error) break;
}
process.stdout.write(`Evidence: ${outputDir}\n`);

import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../../packages/server/src/lib/logger.js";
import { runWithRootLogContext } from "../../packages/server/src/lib/log-context.js";
import { errorHandler } from "../../packages/server/src/middleware/error-handler.js";
import { applyFeatureSettingsValue } from "../../packages/server/src/services/features/feature-settings.js";
import {
  BaseLLMProvider,
  llmHttpErrorFromResponse,
  type ChatMessage,
  type ChatOptions,
  type LLMUsage,
} from "../../packages/server/src/services/llm/base-provider.js";
import { withRateLimitAwareProvider } from "../../packages/server/src/services/llm/rate-limit-aware-provider.js";

const sentinel = "PRIVATE_PROMPT_SENTINEL sk-private-provider-token";
const emitted: unknown[][] = [];
const priorError = logger.error;
logger.error = ((...args: unknown[]) => emitted.push(args)) as typeof logger.error;

function response(requestId: string, body: string, status = 502): Response {
  const result = new Response(body, {
    status,
    headers: {
      "retry-after": "2",
      "x-request-id": requestId,
      "x-provider-error-code": "UPSTREAM_FAILURE",
    },
  });
  Object.defineProperty(result, "url", { value: "https://api.example.test/v1/chat" });
  return result;
}

try {
  await test("provider diagnostics default off and are rechecked when an error is handled", async () => {
    applyFeatureSettingsValue(null);
    const before = emitted.length;
    const disabledError = llmHttpErrorFromResponse(
      `provider failure: ${sentinel}`,
      response("req_abcdefgh12345678", sentinel),
    );
    assert.equal(disabledError.diagnostic, undefined);
    assert.equal(disabledError.status, 502);
    assert.equal(disabledError.retryAfterMs, 2_000);
    assert.equal(emitted.length, before, "disabled diagnostics do not emit the optional provider event");

    applyFeatureSettingsValue(JSON.stringify({ providerDiagnostics: true }));
    const enabledError = llmHttpErrorFromResponse(
      `provider failure: ${sentinel}`,
      response("req_abcdefgh12345678", sentinel),
    );
    assert(enabledError.diagnostic);
    const logs: unknown[][] = [];
    const reply = {
      log: {
        error(...args: unknown[]) {
          logs.push(args);
        },
      },
      status(code: number) {
        return {
          send(value: unknown) {
            return { code, value };
          },
        };
      },
      send(value: unknown) {
        return value;
      },
    };
    applyFeatureSettingsValue(JSON.stringify({ providerDiagnostics: false }));
    errorHandler(enabledError as never, {} as never, reply as never);
    assert.equal(JSON.stringify(logs).includes(sentinel), false);
    assert.equal(JSON.stringify(logs).includes(enabledError.diagnostic.diagnosticRef), false);
    assert.equal(
      JSON.stringify(logs).includes("502"),
      true,
      "typed provider status remains available in safe fallback logs",
    );
  });

  await test("provider diagnostics correlate safe API references without reading response bodies", async () => {
    applyFeatureSettingsValue(JSON.stringify({ providerDiagnostics: true }));
    const failures = await Promise.all([
      runWithRootLogContext({ requestId: "request-0000000000000001" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 8));
        return llmHttpErrorFromResponse(`provider failure: ${sentinel}`, response("req_abcdefgh12345678", sentinel));
      }),
      runWithRootLogContext({ requestId: "request-0000000000000002" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return llmHttpErrorFromResponse(
          `provider failure: ${sentinel}`,
          response("sk-private-provider-token", sentinel),
        );
      }),
    ]);

    assert.notEqual(failures[0]!.diagnostic?.diagnosticRef, failures[1]!.diagnostic?.diagnosticRef);
    assert.equal(failures[0]!.status, 502);
    assert.equal(failures[0]!.retryAfterMs, 2_000);
    assert.equal(failures[0]!.diagnostic?.providerRequestId, "req_abcdefgh12345678");
    assert.equal(failures[1]!.diagnostic?.providerRequestId, undefined, "credential-like headers are omitted");

    const serializedLogs = JSON.stringify(emitted);
    assert.equal(serializedLogs.includes(sentinel), false, "routine provider diagnostics exclude body and error text");
    for (const [error, expectedRequestId] of [
      [failures[0]!, "request-0000000000000001"],
      [failures[1]!, "request-0000000000000002"],
    ] as const) {
      const [fields] =
        emitted.find(
          ([candidate]) => (candidate as { diagnosticRef?: string }).diagnosticRef === error.diagnostic?.diagnosticRef,
        ) ?? [];
      assert.equal((fields as { requestId?: string } | undefined)?.requestId, expectedRequestId);
    }

    let status = 0;
    let payload: unknown;
    const reply = {
      status(code: number) {
        status = code;
        return this;
      },
      send(value: unknown) {
        payload = value;
        return value;
      },
    };
    errorHandler(failures[0] as never, {} as never, reply as never);
    assert.equal(status, 500);
    assert.deepEqual(payload, {
      error: "Internal Server Error",
      diagnosticRef: failures[0]!.diagnostic!.diagnosticRef,
    });
  });

  await test("provider HTTP diagnostics preserve partial stream completion without logging error text", async () => {
    applyFeatureSettingsValue(JSON.stringify({ providerDiagnostics: true }));
    const streamResponse = response("req_abcdefgh12345678", sentinel);
    let providerError = runWithRootLogContext({ requestId: "request-0000000000000003" }, () =>
      llmHttpErrorFromResponse(`provider failure: ${sentinel}`, streamResponse),
    );
    assert.equal(streamResponse.bodyUsed, false, "diagnostic extraction never consumes the response body");

    class PartialFailureProvider extends BaseLLMProvider {
      constructor() {
        super("", "");
      }

      async *chat(_messages: ChatMessage[], _options: ChatOptions): AsyncGenerator<string, LLMUsage | void, unknown> {
        yield "partial";
        throw providerError;
      }
    }

    const warnings: unknown[][] = [];
    const priorWarn = logger.warn;
    logger.warn = ((...args: unknown[]) => warnings.push(args)) as typeof logger.warn;
    try {
      const result = await new PartialFailureProvider().chatComplete([{ role: "user", content: "hello" }], {
        model: "fixture",
        stream: true,
      });
      assert.equal(result.content, "partial");
      assert.equal(result.finishReason, "error");
      assert(
        warnings.some(
          ([fields]) =>
            (fields as { diagnosticRef?: string }).diagnosticRef === providerError.diagnostic?.diagnosticRef,
        ),
      );

      applyFeatureSettingsValue(JSON.stringify({ providerDiagnostics: false }));
      for (const prebuilt of [true, false]) {
        if (!prebuilt)
          providerError = llmHttpErrorFromResponse(
            `provider failure: ${sentinel}`,
            response("req_abcdefgh12345678", sentinel),
          );
        warnings.length = 0;
        const disabled = await new PartialFailureProvider().chatComplete([{ role: "user", content: "hello" }], {
          model: "fixture",
          stream: true,
        });
        assert.equal(disabled.content, "partial");
        assert.equal(disabled.finishReason, "error");
        assert.equal(
          JSON.stringify(warnings).includes("diagnosticRef"),
          false,
          "OFF suppresses even a previously constructed diagnostic",
        );
        assert.equal(
          JSON.stringify(warnings).includes(sentinel),
          false,
          "OFF cannot restore raw provider error logging",
        );
        assert.equal((warnings[0]?.[0] as { providerStatus?: number }).providerStatus, 502);
      }
    } finally {
      logger.warn = priorWarn;
    }
    assert.equal(JSON.stringify(warnings).includes(sentinel), false, "partial result warnings use only the reference");
  });

  await test("rate-limit wrapper rethrows the same terminal error and preserves abort behavior", async () => {
    applyFeatureSettingsValue(JSON.stringify({ providerDiagnostics: true }));
    const terminalResponse = response("req_abcdefgh12345678", sentinel, 401);
    const terminalError = runWithRootLogContext({ requestId: "request-0000000000000004" }, () =>
      llmHttpErrorFromResponse(`provider failure: ${sentinel}`, terminalResponse),
    );
    let terminalCalls = 0;
    class TerminalFailureProvider extends BaseLLMProvider {
      constructor() {
        super("", "");
      }

      async *chat(_messages: ChatMessage[], _options: ChatOptions): AsyncGenerator<string, LLMUsage | void, unknown> {
        terminalCalls += 1;
        throw terminalError;
      }
    }

    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
    const terminalWrapper = withRateLimitAwareProvider(new TerminalFailureProvider(), "provider-diagnostic-terminal");
    const terminalDiagnosticRef = terminalError.diagnostic!.diagnosticRef;
    await assert.rejects(
      terminalWrapper.chatComplete(messages, { model: "fixture", stream: true }),
      (error) =>
        error === terminalError && (error as typeof terminalError).diagnostic?.diagnosticRef === terminalDiagnosticRef,
    );
    assert.equal(terminalCalls, 1, "non-retryable provider status is terminal");
    assert.equal(terminalError.status, 401);
    assert.equal(terminalError.retryAfterMs, 2_000);
    assert.equal(terminalError.diagnostic?.diagnosticRef, terminalDiagnosticRef);

    const abortError = Object.assign(new Error("stopped"), { name: "AbortError" });
    let abortCalls = 0;
    class AbortProvider extends BaseLLMProvider {
      constructor() {
        super("", "");
      }

      async *chat(_messages: ChatMessage[], options: ChatOptions): AsyncGenerator<string, LLMUsage | void, unknown> {
        abortCalls += 1;
        await new Promise<void>((_resolve, reject) => {
          if (options.signal?.aborted) return reject(abortError);
          options.signal?.addEventListener("abort", () => reject(abortError), { once: true });
        });
        throw abortError;
      }
    }

    const controller = new AbortController();
    const abortWrapper = withRateLimitAwareProvider(new AbortProvider(), "provider-diagnostic-abort");
    const pending = abortWrapper.chatComplete(messages, {
      model: "fixture",
      stream: true,
      signal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, (error) => error === abortError);
    assert.equal(abortCalls, 1, "abort is not retried");
  });
  await test("generation SSE forwards the same provider diagnostic reference and original message", async () => {
    applyFeatureSettingsValue(JSON.stringify({ providerDiagnostics: true }));
    const previousEnv = Object.fromEntries(
      ["DATA_DIR", "FILE_STORAGE_DIR", "NODE_ENV", "MARINARA_LITE", "LOG_LEVEL"].map((key) => [key, process.env[key]]),
    );
    let dataDir: string | undefined;
    let closeDatabase: (() => Promise<void>) | undefined;
    let provider: ReturnType<typeof createServer> | undefined;
    let app: import("fastify").FastifyInstance | undefined;

    try {
      dataDir = mkdtempSync(join(tmpdir(), "marinara-provider-diagnostic-route-"));
      process.env.DATA_DIR = dataDir;
      process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
      process.env.NODE_ENV = "test";
      process.env.MARINARA_LITE = "true";
      process.env.LOG_LEVEL = "silent";

      const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
      const Fastify = requireServer("fastify") as typeof import("fastify").default;
      const [
        { getDB, closeDB },
        { generateRoutes },
        { createChatsStorage },
        { createConnectionsStorage },
        { createCharactersStorage },
        { createPromptsStorage },
        { characterDataSchema },
      ] = await Promise.all([
        import("../../packages/server/src/db/connection.js"),
        import("../../packages/server/src/routes/generate.routes.js"),
        import("../../packages/server/src/services/storage/chats.storage.js"),
        import("../../packages/server/src/services/storage/connections.storage.js"),
        import("../../packages/server/src/services/storage/characters.storage.js"),
        import("../../packages/server/src/services/storage/prompts.storage.js"),
        import("../../packages/shared/dist/index.js"),
      ]);
      closeDatabase = closeDB;

      let providerCalls = 0;
      provider = createServer((_request, response) => {
        providerCalls += 1;
        response.writeHead(401, {
          "content-type": "application/json",
          "retry-after": "2",
          "x-request-id": "req_abcdefgh12345678",
          "x-provider-error-code": "AUTH_FAILED",
        });
        response.end(JSON.stringify({ error: { message: "synthetic auth failure" } }));
      });
      const db = await getDB();
      app = Fastify();
      app.decorate("db", db);
      app.decorate("activeGenerations", new Map());
      await app.register(generateRoutes, { prefix: "/api/generate" });

      await once(provider.listen(0, "127.0.0.1"), "listening");
      const address = provider.address();
      assert(address && typeof address === "object");
      const connection = await createConnectionsStorage(db).create({
        name: "Provider diagnostics route fixture",
        provider: "custom",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "fixture",
        apiKey: "fixture",
        maxContext: 32768,
        maxTokensOverride: 512,
      });
      assert(connection);
      const characters = createCharactersStorage(db);
      const character = await characters.create(characterDataSchema.parse({ name: "Fixture" }));
      assert(character);
      const persona = await characters.createPersona("Fixture player", "The player.");
      assert(persona);
      const prompts = createPromptsStorage(db);
      const preset = await prompts.create({
        name: "Provider diagnostics route fixture",
        parameters: { maxTokens: 512, maxContext: 32768 },
        wrapFormat: "xml",
      });
      assert(preset);
      await prompts.createSection({
        presetId: preset.id,
        identifier: "rules",
        name: "Rules",
        content: "Respond as {{char}}.",
      });
      await prompts.createSection({
        presetId: preset.id,
        identifier: "history",
        name: "Chat History",
        isMarker: true,
        markerConfig: { type: "chat_history" },
      });
      const chats = createChatsStorage(db);
      const chat = await chats.create({
        name: "Provider diagnostics route fixture",
        mode: "roleplay",
        characterIds: [character.id],
        personaId: persona.id,
        connectionId: connection.id,
        promptPresetId: preset.id,
      });
      assert(chat);
      await chats.createMessage({ chatId: chat.id, role: "user", content: "Continue." });

      const emittedBefore = emitted.length;
      const reply = await app.inject({
        method: "POST",
        url: "/api/generate/",
        payload: { chatId: chat.id, forCharacterId: character.id },
      });
      assert.equal(reply.statusCode, 200);
      assert.equal(providerCalls, 1, "terminal 401 reaches one local stub-provider request");
      const events = reply.body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as { type?: string; data?: string });
      const errorEvent = events.find((event) => event.type === "error");
      assert(errorEvent && typeof errorEvent.data === "string", reply.body);
      const routeLog = emitted
        .slice(emittedBefore)
        .find(
          ([, message]) =>
            message === "[generate] Generation failed; provider details are available by diagnostic reference",
        );
      const diagnosticRef = (routeLog?.[0] as { diagnosticRef?: string } | undefined)?.diagnosticRef;
      assert(diagnosticRef, "the real route catch logs a diagnostic reference");
      assert.equal(
        errorEvent.data,
        `Custom OpenAI-compatible endpoint error 401: synthetic auth failure (Diagnostic reference: ${diagnosticRef})`,
        "the actual SSE catch preserves the existing provider message and appends the same reference",
      );

      const priorRouteError = logger.error;
      logger.error = ((...args: unknown[]) => {
        emitted.push(args);
        if (args[1] === "LLM provider request failed") {
          applyFeatureSettingsValue(JSON.stringify({ providerDiagnostics: false }));
        }
      }) as typeof logger.error;
      try {
        const disabledBeforeCatch = emitted.length;
        const disabledReply = await app.inject({
          method: "POST",
          url: "/api/generate/",
          payload: { chatId: chat.id, forCharacterId: character.id },
        });
        const disabledEvents = disabledReply.body
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)) as { type?: string; data?: string });
        const disabledErrorEvent = disabledEvents.find((event) => event.type === "error");
        assert(disabledErrorEvent && typeof disabledErrorEvent.data === "string", disabledReply.body);
        assert.equal(disabledErrorEvent.data, "Custom OpenAI-compatible endpoint error 401: synthetic auth failure");
        assert.equal(
          emitted.slice(disabledBeforeCatch).some(([, message]) => message === "[generate] Provider request failed"),
          true,
          "the route emits only the safe typed fallback after the setting turns off",
        );
      } finally {
        logger.error = priorRouteError;
      }
      for (const setting of [null, JSON.stringify({ providerDiagnostics: false })]) {
        applyFeatureSettingsValue(setting);
        const beforeCalls = providerCalls;
        const beforeLogs = emitted.length;
        const disabledReply = await app.inject({
          method: "POST",
          url: "/api/generate/",
          payload: { chatId: chat.id, forCharacterId: character.id },
        });
        assert.equal(disabledReply.statusCode, 200);
        assert.equal(providerCalls, beforeCalls + 1, "OFF preserves the ordinary provider request");
        assert(disabledReply.body.includes("synthetic auth failure"));
        assert.equal(disabledReply.body.includes("Diagnostic reference"), false);
        assert.equal(JSON.stringify(emitted.slice(beforeLogs)).includes("diagnosticRef"), false);
        assert.equal(
          JSON.stringify(emitted.slice(beforeLogs)).includes("synthetic auth failure"),
          false,
          "routine logs never serialize provider error text when OFF",
        );
      }
    } finally {
      try {
        if (app) await app.close();
      } finally {
        try {
          const ownedProvider = provider;
          if (ownedProvider?.listening) {
            await new Promise<void>((resolve, reject) =>
              ownedProvider.close((error) => (error ? reject(error) : resolve())),
            );
          }
        } finally {
          try {
            if (closeDatabase) await closeDatabase();
          } finally {
            try {
              if (dataDir) rmSync(dataDir, { recursive: true, force: true });
            } finally {
              for (const [key, value] of Object.entries(previousEnv)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
              }
            }
          }
        }
      }
    }
  });
} finally {
  applyFeatureSettingsValue(null);
  logger.error = priorError;
}

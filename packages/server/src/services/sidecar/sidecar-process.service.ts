import { spawn, type ChildProcess } from "child_process";
import { logger } from "../../lib/logger.js";
import { createDiagnostic, sanitizeDiagnosticText } from "../../lib/diagnostics.js";
import { reportDiagnosticError } from "../../lib/diagnostic-operation.js";
import { logEvent } from "../../lib/log-events.js";
import { orFallback } from "../../lib/best-effort.js";
import { registerWorkerGauge } from "../../lib/worker-gauges.js";
import { createWriteStream, existsSync, readFileSync, renameSync, writeFileSync, type WriteStream } from "fs";
import { createServer } from "net";
import { dirname, join } from "path";
import type { SidecarBackend } from "@marinara-engine/shared";
import { sidecarModelService } from "./sidecar-model.service.js";
import { isAbortError } from "./sidecar-download.js";
import { buildLlamaArgs, buildLlamaStartupPlans } from "./sidecar-launch-plan.js";
import { buildLlamaProcessEnv } from "./sidecar-runtime-env.js";
import { mlxRuntimeService, type MlxRuntimeInstall } from "./mlx-runtime.service.js";
import { sidecarRuntimeService, type SidecarRuntimeInstall } from "./sidecar-runtime.service.js";
import { assertSupportedLlamaCppModelPath } from "./sidecar-model-files.js";
import { resolveSidecarRequestModel } from "./sidecar-request-model.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a localhost port")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

type ManagedRuntimeInstall = SidecarRuntimeInstall | MlxRuntimeInstall;

/** Facts about one spawned sidecar child for its spawn, ready and exit log lines. Never holds arguments or output text beyond the sanitized stderr tail. */
type ChildLaunchMeta = {
  backend: SidecarBackend;
  variant: string;
  plan?: string;
  gpuLayers?: number;
  port: number;
  attempt: number;
  maxAttempts: number;
};
type ChildState = ChildLaunchMeta & { startedAt: number; stderrLines: string[]; stderrPartial: string };

const STDERR_RING_LINES = 40;
const STDERR_TAIL_LOG_LINES = 20;
const CRASH_WINDOW_MS = 5 * 60_000;

function pushStderrLines(state: ChildState, chunk: unknown): void {
  const text = state.stderrPartial + String(chunk);
  const lines = text.split(/\r?\n/u);
  state.stderrPartial = (lines.pop() ?? "").slice(-2_000);
  for (const line of lines) {
    if (!line.trim()) continue;
    state.stderrLines.push(line.length > 500 ? line.slice(0, 500) : line);
  }
  if (state.stderrLines.length > STDERR_RING_LINES) {
    state.stderrLines.splice(0, state.stderrLines.length - STDERR_RING_LINES);
  }
}

function stderrTailOf(state: ChildState | undefined): string | undefined {
  if (!state) return undefined;
  const lines = [...state.stderrLines];
  if (state.stderrPartial.trim()) lines.push(state.stderrPartial);
  const tail = lines.slice(-STDERR_TAIL_LOG_LINES).join("\n");
  return tail ? sanitizeDiagnosticText(tail, 2_000) : undefined;
}
type SyncOptions = {
  suppressKnownFailure?: boolean;
  forceStart?: boolean;
  allowRuntimeInstall?: boolean;
  preemptStarting?: boolean;
};
type EnsureReadyOptions = {
  forceStart?: boolean;
  allowRuntimeInstall?: boolean;
};

class SidecarServerExitError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(code: number | null, signal: NodeJS.Signals | null) {
    const reason = signal ? `signal ${signal}` : `exit ${code ?? "null"}`;
    super(`The local sidecar server exited before becoming ready (${reason})`);
    this.name = "SidecarServerExitError";
    this.exitCode = code;
    this.signal = signal;
  }
}

class SidecarStartupTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for the local sidecar server to become ready");
    this.name = "SidecarStartupTimeoutError";
  }
}

class SidecarStartupCancelledError extends Error {
  constructor() {
    super("Local sidecar startup was cancelled");
    this.name = "SidecarStartupCancelledError";
  }
}

class SidecarProcessService {
  private child: ChildProcess | null = null;
  private logStream: WriteStream | null = null;
  private baseUrl: string | null = null;
  private ready = false;
  private currentSignature: string | null = null;
  private failedSignature: string | null = null;
  private startupError: string | null = null;
  private failedRuntimeVariant: string | null = null;
  private intentionalStop = false;
  private stopRequested = false;
  private stopRequestId = 0;
  private unexpectedCrashCount = 0;
  private unexpectedCrashWindowStartedAt = 0;
  private starting = false;
  private manuallyUnloaded = false;
  private syncLock: Promise<void> = Promise.resolve();
  private childErrors = new WeakMap<ChildProcess, Error>();
  private childStates = new WeakMap<ChildProcess, ChildState>();

  /** Cheap numbers for runtime.memory lines (worker gauge "sidecar"). */
  sampleGauge(): Record<string, unknown> {
    return {
      running: this.child ? 1 : 0,
      ready: this.ready,
      starting: this.starting,
      pid: this.child?.pid,
      crashCount: this.unexpectedCrashCount,
    };
  }

  isReady(): boolean {
    return this.ready && this.baseUrl !== null;
  }

  /**
   * The running llama-server's process id, so its device memory can be measured
   * rather than estimated from the model file. Null when nothing is running.
   */
  getProcessId(): number | null {
    return this.child?.pid ?? null;
  }

  getBaseUrl(): string | null {
    return this.baseUrl;
  }

  getStartupError(): string | null {
    return this.startupError;
  }

  getFailedRuntimeVariant(): string | null {
    return this.failedRuntimeVariant;
  }

  async ensureReady(options: EnsureReadyOptions = {}): Promise<string> {
    const forceStart = options.forceStart ?? false;
    const allowRuntimeInstall = options.allowRuntimeInstall ?? false;
    await this.syncForCurrentConfig({
      suppressKnownFailure: !forceStart,
      forceStart,
      allowRuntimeInstall,
    });
    if (!this.ready || !this.baseUrl) {
      throw this.buildNotReadyError({ forceStart });
    }
    return this.baseUrl;
  }

  async syncForCurrentConfig(options?: boolean | SyncOptions): Promise<void> {
    const normalizedOptions = this.normalizeSyncOptions(options);
    const preemptStopRequestId =
      normalizedOptions.preemptStarting && this.starting ? this.requestStopForStartup("sync") : null;
    return this.withLock(async () => {
      if (preemptStopRequestId !== null) {
        this.clearStopRequest(preemptStopRequestId);
      }
      await this.syncUnlocked(normalizedOptions);
    });
  }

  async restart(): Promise<void> {
    const stopRequestId = this.requestStopForStartup("restart");
    return this.withLock(async () => {
      this.clearStopRequest(stopRequestId);
      this.manuallyUnloaded = false;
      this.clearStartupFailure();
      this.unexpectedCrashCount = 0;
      this.unexpectedCrashWindowStartedAt = 0;
      this.currentSignature = null;
      await this.stopUnlocked();
      await this.syncUnlocked({ forceStart: true, allowRuntimeInstall: false });
      if (!this.ready || !this.baseUrl) {
        throw this.buildNotReadyError({ forceStart: true });
      }
    });
  }

  async installRuntime(): Promise<void> {
    return this.withLock(async () => {
      this.clearStartupFailure();
      const backend = sidecarModelService.getResolvedBackend();
      const hadUsableRuntime = this.isRuntimeInstalled(backend);
      if (!hadUsableRuntime) {
        await this.stopUnlocked();
      }
      await this.ensureRuntimeInstalled(backend);
      if (!hadUsableRuntime) {
        this.cleanupInactiveRuntimeBackends(backend);
      }

      if (sidecarModelService.getConfiguredModelRef() && sidecarModelService.isEnabled()) {
        await this.syncUnlocked({ allowRuntimeInstall: false });
      } else {
        sidecarModelService.setStatus(sidecarModelService.getConfiguredModelRef() ? "downloaded" : "not_downloaded");
      }
    });
  }

  async reinstallRuntime(): Promise<void> {
    return this.withLock(async () => {
      await this.stopUnlocked();
      this.clearStartupFailure();

      const backend = sidecarModelService.getResolvedBackend();
      if (backend === "mlx") {
        mlxRuntimeService.resetRuntime();
      } else {
        if (sidecarRuntimeService.getStatus(sidecarModelService.getConfig().runtimePreference).source === "system") {
          throw new Error(
            "The local runtime is using a system llama-server from PATH. Reinstall that runtime outside Marinara.",
          );
        }
        sidecarRuntimeService.resetRuntime();
      }

      if (sidecarModelService.getConfiguredModelRef() && sidecarModelService.isEnabled()) {
        await this.syncUnlocked({ allowRuntimeInstall: true });
      } else {
        await this.ensureRuntimeInstalled(backend);
        sidecarModelService.setStatus(sidecarModelService.getConfiguredModelRef() ? "downloaded" : "not_downloaded");
      }

      this.cleanupInactiveRuntimeBackends(backend);
    });
  }

  async unload(): Promise<void> {
    const stopRequestId = this.requestStopForStartup("unload");

    return this.withLock(async () => {
      try {
        this.manuallyUnloaded = true;
        await this.stopAndUpdateStatusUnlocked();
      } finally {
        this.clearStopRequest(stopRequestId);
      }
    });
  }

  async stop(): Promise<void> {
    const stopRequestId = this.requestStopForStartup("stop");

    return this.withLock(async () => {
      try {
        await this.stopAndUpdateStatusUnlocked();
      } finally {
        this.clearStopRequest(stopRequestId);
      }
    });
  }

  private async stopAndUpdateStatusUnlocked(): Promise<void> {
    await this.stopUnlocked();
    this.clearStartupFailure();
    this.unexpectedCrashCount = 0;
    this.unexpectedCrashWindowStartedAt = 0;
    sidecarModelService.setStatus(sidecarModelService.getConfiguredModelRef() ? "downloaded" : "not_downloaded");
  }

  killCurrentChildForProcessExit(): void {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      return;
    }

    this.intentionalStop = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // Best-effort process-exit reaping.
    }

    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best-effort forced process-exit reaping.
      }
    }
  }

  private requestStopForStartup(reason: "restart" | "stop" | "sync" | "unload"): number {
    this.stopRequested = true;
    this.stopRequestId += 1;
    const stopRequestId = this.stopRequestId;

    if (!this.starting || !this.child) {
      return stopRequestId;
    }

    this.intentionalStop = true;
    try {
      this.child.kill("SIGTERM");
    } catch {
      logger.debug("[sidecar] Failed to signal startup child during %s", reason);
    }

    return stopRequestId;
  }

  private clearStopRequest(stopRequestId: number): void {
    if (this.stopRequestId === stopRequestId) {
      this.stopRequested = false;
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.syncLock;
    this.syncLock = next;
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private normalizeSyncOptions(options?: boolean | SyncOptions): SyncOptions {
    if (typeof options === "boolean") {
      return { forceStart: options, allowRuntimeInstall: false };
    }
    return options ?? {};
  }

  private buildNotReadyError(options: { forceStart?: boolean } = {}): Error {
    if (!sidecarModelService.getConfiguredModelRef()) {
      return new Error("Download or select a local model before using the local sidecar.");
    }

    const backend = sidecarModelService.getResolvedBackend();
    if (!this.isRuntimeInstalled(backend)) {
      return new Error("Install the local runtime from Local AI Model before using the local sidecar.");
    }

    if (!options.forceStart && !sidecarModelService.isEnabled()) {
      return new Error(
        "Enable the local model for trackers or game scene analysis, or start it manually from Local AI Model.",
      );
    }

    return new Error(this.startupError ?? "The local sidecar server is not ready");
  }

  private isRuntimeInstalled(backend: SidecarBackend): boolean {
    if (backend === "mlx") {
      return mlxRuntimeService.getStatus().installed;
    }

    return sidecarRuntimeService.getStatus(sidecarModelService.getConfig().runtimePreference).installed;
  }

  private async syncUnlocked(options: SyncOptions = {}): Promise<void> {
    const modelRef = sidecarModelService.getConfiguredModelRef();
    const backend = sidecarModelService.getResolvedBackend();

    if (options.forceStart) {
      this.manuallyUnloaded = false;
    }

    // While a model download is running the config still names the old model. Auto-starting it
    // would reload (and on Windows lock) the file the download is about to replace, and would
    // overwrite the downloading_model status. Only explicit force starts may proceed.
    if (!options.forceStart && sidecarModelService.isDownloadingModel()) {
      return;
    }

    if (!modelRef) {
      await this.stopUnlocked();
      this.clearStartupFailure();
      sidecarModelService.setStatus("not_downloaded");
      return;
    }

    if (this.manuallyUnloaded) {
      await this.stopUnlocked();
      this.clearStartupFailure();
      sidecarModelService.setStatus("downloaded");
      return;
    }

    if (!options.forceStart && !sidecarModelService.isEnabled()) {
      await this.stopUnlocked();
      this.clearStartupFailure();
      sidecarModelService.setStatus("downloaded");
      return;
    }

    if (!options.allowRuntimeInstall && !this.isRuntimeInstalled(backend)) {
      await this.stopUnlocked();
      this.clearStartupFailure();
      sidecarModelService.setStatus("downloaded");
      return;
    }

    const runtime = await this.ensureRuntimeInstalled(backend);
    const nextSignature = this.buildRuntimeSignature(backend, runtime, modelRef);

    if (this.child && this.ready && this.currentSignature === nextSignature) {
      sidecarModelService.setStatus("ready");
      return;
    }

    if (options.suppressKnownFailure && !this.child && !this.ready && this.failedSignature === nextSignature) {
      sidecarModelService.setStatus("server_error");
      return;
    }

    sidecarModelService.setStatus("starting_server");
    await this.stopUnlocked();
    await this.startUnlocked(runtime, modelRef);
  }

  private async ensureRuntimeInstalled(
    backend: SidecarBackend,
    options?: { excludeVariants?: string[] },
  ): Promise<ManagedRuntimeInstall> {
    sidecarModelService.setStatus("downloading_runtime");
    try {
      if (backend === "mlx") {
        return await mlxRuntimeService.ensureInstalled((progress) => {
          sidecarModelService.emitExternalProgress(progress);
        });
      }

      return await sidecarRuntimeService.ensureInstalled(
        (progress) => {
          sidecarModelService.emitExternalProgress(progress);
        },
        {
          ...options,
          preference: sidecarModelService.getConfig().runtimePreference,
        },
      );
    } catch (error) {
      if (isAbortError(error)) {
        sidecarModelService.setStatus(sidecarModelService.getConfiguredModelRef() ? "downloaded" : "not_downloaded");
      } else {
        sidecarModelService.setStatus("server_error");
      }
      throw error;
    }
  }

  private isMlxRuntime(runtime: ManagedRuntimeInstall): runtime is MlxRuntimeInstall {
    return "pythonPath" in runtime;
  }

  private cleanupInactiveRuntimeBackends(activeBackend: SidecarBackend): void {
    if (activeBackend === "mlx") {
      sidecarRuntimeService.resetRuntime();
      return;
    }

    mlxRuntimeService.resetRuntime();
  }

  private getLlamaServerPath(runtime: ManagedRuntimeInstall): string {
    if (this.isMlxRuntime(runtime)) {
      throw new Error("Expected a llama.cpp runtime install");
    }
    return runtime.serverPath;
  }

  private getMlxPythonPath(runtime: ManagedRuntimeInstall): string {
    if (!this.isMlxRuntime(runtime)) {
      throw new Error("Expected an MLX runtime install");
    }
    return runtime.pythonPath;
  }

  private buildLlamaArgs(modelPath: string, gpuLayers: number, port: number, runtime: SidecarRuntimeInstall): string[] {
    const config = sidecarModelService.getConfig();
    return buildLlamaArgs({
      modelPath,
      gpuLayers,
      port,
      contextSize: config.contextSize,
      runtimeVariant: runtime.variant,
      enableNativeToolCalls: config.enableNativeToolCalls,
      embeddingPooling: config.embeddingPooling,
      embeddingBatchSize: config.embeddingBatchSize,
      maxParallelJobs: config.maxParallelJobs,
    });
  }

  private buildMlxArgs(modelRepo: string, port: number): string[] {
    return ["-m", "mlx_lm.server", "--model", modelRepo, "--host", "127.0.0.1", "--port", String(port)];
  }

  private async waitForCompletionProbe(baseUrl: string, backend: SidecarBackend): Promise<void> {
    const model = resolveSidecarRequestModel(backend, sidecarModelService.getConfiguredModelRef());
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 1,
        temperature: 0,
        top_p: 1,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
    }
  }

  private usesGpuRuntime(runtime: SidecarRuntimeInstall): boolean {
    return runtime.gpuCapable ?? sidecarRuntimeService.isGpuVariant(runtime.variant);
  }

  private buildLlamaStartupPlans(runtime: SidecarRuntimeInstall): Array<{ gpuLayers: number; label: string }> {
    const config = sidecarModelService.getConfig();
    return buildLlamaStartupPlans({
      configuredGpuLayers: config.gpuLayers,
      usesGpuRuntime: this.usesGpuRuntime(runtime),
    });
  }

  private shouldRetryStartup(error: unknown): boolean {
    return error instanceof SidecarServerExitError || error instanceof SidecarStartupTimeoutError;
  }

  private formatCommandArgs(args: string[]): string {
    return args.map((arg) => (/[\s"]/u.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
  }

  private readRecentLogLines(maxLines = 12): string | null {
    try {
      const log = readFileSync(sidecarRuntimeService.getLogPath(), "utf-8").trim();
      if (!log) {
        return null;
      }
      return log.split(/\r?\n/u).slice(-maxLines).join("\n");
    } catch {
      return null;
    }
  }

  private decorateStartupError(error: unknown, commandFile: string, args: string[]): Error {
    const baseMessage = error instanceof Error ? error.message : "The local sidecar server failed to start";
    const commandLine = `${commandFile} ${this.formatCommandArgs(args)}`.trim();
    const recentLogs = this.readRecentLogLines();
    if (!recentLogs) {
      return new Error(`${baseMessage}\nCommand: ${commandLine}`);
    }
    return new Error(`${baseMessage}\nCommand: ${commandLine}\nRecent sidecar log:\n${recentLogs}`);
  }

  private getChildExitError(child: ChildProcess): Error | null {
    const spawnError = this.childErrors.get(child);
    if (spawnError) {
      return spawnError;
    }

    if (child.exitCode === null && child.signalCode === null) {
      return null;
    }
    return new SidecarServerExitError(child.exitCode, child.signalCode);
  }

  private buildRuntimeSignature(backend: SidecarBackend, runtime: ManagedRuntimeInstall, modelRef: string): string {
    const config = sidecarModelService.getConfig();
    return backend === "mlx"
      ? JSON.stringify({
          backend,
          pythonPath: this.getMlxPythonPath(runtime),
          modelRef,
          contextSize: config.contextSize,
        })
      : JSON.stringify({
          backend,
          serverPath: this.getLlamaServerPath(runtime),
          modelRef,
          contextSize: config.contextSize,
          maxParallelJobs: config.maxParallelJobs,
          gpuLayers: config.gpuLayers,
          enableNativeToolCalls: config.enableNativeToolCalls,
          embeddingPooling: config.embeddingPooling,
          embeddingBatchSize: config.embeddingBatchSize,
        });
  }

  private clearStartupFailure(): void {
    this.failedSignature = null;
    this.startupError = null;
    this.failedRuntimeVariant = null;
  }

  private summarizeStartupError(error: unknown): string {
    const message = error instanceof Error ? error.message : "The local sidecar server failed to start";
    return message.split(/\r?\n/u)[0]?.trim() || "The local sidecar server failed to start";
  }

  private rememberStartupFailure(
    signature: string,
    runtimeVariant: string | null,
    error: unknown,
    attemptedVariants: string[] = runtimeVariant ? [runtimeVariant] : [],
  ): void {
    this.failedSignature = signature;
    this.failedRuntimeVariant = runtimeVariant;
    this.startupError = this.summarizeStartupError(error);
    sidecarModelService.setStatus("server_error");
    reportDiagnosticError(error, { stage: "sidecar.start" }, undefined, {
      event: "sidecar.start",
      message: "[sidecar] Local sidecar server failed to start",
      fields: { outcome: "failed", variant: runtimeVariant, attemptedVariants },
    });
  }

  /** Keeps the previous run's side log as <log>.prev instead of discarding it. */
  private rotateSideLog(): void {
    const logPath = sidecarRuntimeService.getLogPath();
    try {
      if (existsSync(logPath)) renameSync(logPath, `${logPath}.prev`);
    } catch (error) {
      logger.debug(
        { err: error, event: "sidecar.start", stage: "side-log-rotate", errorCode: createDiagnostic(error).code },
        "[sidecar] Could not rotate the side log; truncating it instead",
      );
    }
    writeFileSync(logPath, "", "utf-8");
  }

  private async startUnlocked(runtime: ManagedRuntimeInstall, modelRef: string): Promise<void> {
    this.rotateSideLog();
    this.starting = true;
    try {
      if (this.isMlxRuntime(runtime)) {
        await this.startMlxUnlocked(runtime, modelRef);
        return;
      }

      await this.startLlamaUnlocked(runtime, modelRef);
    } finally {
      this.starting = false;
    }
  }

  private async startLlamaUnlocked(runtime: SidecarRuntimeInstall, modelPath: string): Promise<void> {
    if (!existsSync(modelPath)) {
      throw new Error("The selected sidecar model file is missing. Please download it again.");
    }
    assertSupportedLlamaCppModelPath(modelPath);

    let activeRuntime: SidecarRuntimeInstall | null = runtime;
    const attemptedVariants = new Set<string>();
    let lastError: Error | null = null;
    // Record every attempt, including a fallback runtime, under the requested runtime's signature:
    // that is what syncUnlocked computes, so a working fallback is kept and a failed one is remembered.
    const requestedSignature = this.buildRuntimeSignature("llama_cpp", runtime, modelPath);

    while (activeRuntime) {
      attemptedVariants.add(activeRuntime.variant);

      try {
        await this.startLlamaForInstalledRuntimeUnlocked(activeRuntime, modelPath, requestedSignature);
        return;
      } catch (error) {
        if (error instanceof SidecarStartupCancelledError) {
          throw error;
        }

        lastError = error instanceof Error ? error : new Error("The local sidecar server failed to start");

        const nextRuntime: ManagedRuntimeInstall | null = this.usesGpuRuntime(activeRuntime)
          ? await orFallback(
              this.ensureRuntimeInstalled("llama_cpp", {
                excludeVariants: [...attemptedVariants],
              }),
              null,
              { event: "sidecar.start", stage: "runtime-fallback", variant: activeRuntime.variant },
            )
          : null;

        if (nextRuntime && !this.isMlxRuntime(nextRuntime) && !attemptedVariants.has(nextRuntime.variant)) {
          logger.warn(
            error,
            "[sidecar] Runtime %s failed to boot before ready. Retrying with %s.",
            activeRuntime.variant,
            nextRuntime.variant,
          );
          activeRuntime = nextRuntime;
          continue;
        }

        this.rememberStartupFailure(requestedSignature, activeRuntime.variant, lastError, [...attemptedVariants]);
        throw lastError;
      }
    }

    this.rememberStartupFailure(
      requestedSignature,
      runtime.variant,
      lastError ?? new Error("The local sidecar server failed to start"),
      [...attemptedVariants],
    );
    throw lastError ?? new Error("The local sidecar server failed to start");
  }

  private async startLlamaForInstalledRuntimeUnlocked(
    runtime: SidecarRuntimeInstall,
    modelPath: string,
    signature: string,
  ): Promise<void> {
    const startupPlans = this.buildLlamaStartupPlans(runtime);

    for (let attempt = 0; attempt < startupPlans.length; attempt += 1) {
      if (this.stopRequested) {
        throw new SidecarStartupCancelledError();
      }

      const plan = startupPlans[attempt]!;
      const port = await getFreePort();
      const args = this.buildLlamaArgs(modelPath, plan.gpuLayers, port, runtime);
      sidecarRuntimeService.setLaunchDiagnostics(`${runtime.serverPath} ${this.formatCommandArgs(args)}`, "llama_cpp");

      const logStream = createWriteStream(sidecarRuntimeService.getLogPath(), { flags: "a" });
      logStream.write(`[sidecar] startup attempt ${attempt + 1}/${startupPlans.length} (${plan.label})\n`);
      logStream.write(`[sidecar] runtime variant: ${runtime.variant}\n`);
      logStream.write(`[sidecar] command: ${runtime.serverPath} ${this.formatCommandArgs(args)}\n`);

      const child = spawn(runtime.serverPath, args, {
        cwd: dirname(runtime.serverPath),
        env: buildLlamaProcessEnv(runtime),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.bindChild(child, logStream, `http://127.0.0.1:${port}`, signature, {
        backend: "llama_cpp",
        variant: runtime.variant,
        plan: plan.label,
        gpuLayers: plan.gpuLayers,
        port,
        attempt: attempt + 1,
        maxAttempts: startupPlans.length,
      });

      try {
        await this.waitForReady(this.baseUrl!, child, "llama_cpp");
        this.markReady();
        return;
      } catch (error) {
        const decoratedError = this.decorateStartupError(error, runtime.serverPath, args);
        await this.stopUnlocked();

        if (this.stopRequested) {
          throw new SidecarStartupCancelledError();
        }

        const nextPlan = startupPlans[attempt + 1];
        if (nextPlan && this.shouldRetryStartup(error)) {
          logger.warn(error, "[sidecar] Startup with %s failed. Retrying with %s.", plan.label, nextPlan.label);
          continue;
        }

        throw decoratedError;
      }
    }

    throw new Error("The local sidecar server failed to start");
  }

  private async startMlxUnlocked(runtime: MlxRuntimeInstall, modelRepo: string): Promise<void> {
    if (this.stopRequested) {
      throw new SidecarStartupCancelledError();
    }

    const port = await getFreePort();
    const args = this.buildMlxArgs(modelRepo, port);
    const signature = this.buildRuntimeSignature("mlx", runtime, modelRepo);
    sidecarRuntimeService.setLaunchDiagnostics(`${runtime.pythonPath} ${this.formatCommandArgs(args)}`, "mlx");
    const logStream = createWriteStream(sidecarRuntimeService.getLogPath(), { flags: "a" });
    logStream.write(`[sidecar] startup attempt 1/1 (MLX native)\n`);
    logStream.write(`[sidecar] command: ${runtime.pythonPath} ${this.formatCommandArgs(args)}\n`);

    const child = spawn(runtime.pythonPath, args, {
      cwd: runtime.directoryPath,
      env: {
        ...process.env,
        HF_HOME: runtime.hfHomePath,
        HF_HUB_CACHE: join(runtime.hfHomePath, "hub"),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.bindChild(child, logStream, `http://127.0.0.1:${port}`, signature, {
      backend: "mlx",
      variant: runtime.variant,
      port,
      attempt: 1,
      maxAttempts: 1,
    });

    try {
      await this.waitForReady(this.baseUrl!, child, "mlx");
      this.markReady();
    } catch (error) {
      if (error instanceof SidecarStartupCancelledError) {
        await this.stopUnlocked();
        throw error;
      }

      const decorated = this.decorateStartupError(error, runtime.pythonPath, args);
      await this.stopUnlocked();
      this.rememberStartupFailure(signature, runtime.variant, decorated);
      throw decorated;
    }
  }

  private bindChild(
    child: ChildProcess,
    logStream: WriteStream,
    baseUrl: string,
    signature: string,
    meta: ChildLaunchMeta,
  ): void {
    this.child = child;
    this.logStream = logStream;
    this.baseUrl = baseUrl;
    this.ready = false;
    this.currentSignature = signature;
    this.intentionalStop = false;

    const state: ChildState = { ...meta, startedAt: Date.now(), stderrLines: [], stderrPartial: "" };
    this.childStates.set(child, state);
    // Arguments stay in the side log; the main log gets the launch facts only.
    logEvent("info", "sidecar.spawn", {
      pid: child.pid,
      backend: meta.backend,
      variant: meta.variant,
      plan: meta.plan,
      gpuLayers: meta.gpuLayers,
      port: meta.port,
      attempt: meta.attempt,
      maxAttempts: meta.maxAttempts,
    });

    child.stdout?.on("data", (chunk) => {
      logStream.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      logStream.write(chunk);
      pushStderrLines(state, chunk);
    });
    child.on("error", (error) => {
      const spawnError = error instanceof Error ? error : new Error(String(error));
      this.childErrors.set(child, spawnError);
      logStream.write(`[sidecar] process error: ${spawnError.message}\n`);
      logger.warn(
        {
          err: spawnError,
          event: "sidecar.spawn",
          outcome: "failed",
          errorCode: createDiagnostic(spawnError).code,
          variant: meta.variant,
        },
        "[sidecar] Sidecar process error",
      );

      if (this.child === child) {
        this.startupError = spawnError.message;
        sidecarModelService.setStatus("server_error");
      }
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) {
        return;
      }
      void this.handleChildExit(child, code, signal);
    });
  }

  private markReady(): void {
    const child = this.child;
    const state = child ? this.childStates.get(child) : undefined;
    logEvent("info", "sidecar.ready", {
      pid: child?.pid,
      variant: state?.variant,
      elapsedMs: state ? Date.now() - state.startedAt : undefined,
    });
    this.ready = true;
    this.clearStartupFailure();
    sidecarModelService.setStatus("ready");
    sidecarModelService.clearLegacyRuntimeStamp();
  }

  private async waitForReady(baseUrl: string, child: ChildProcess, backend: SidecarBackend): Promise<void> {
    const timeoutAt = Date.now() + (backend === "mlx" ? 20 * 60_000 : 60_000);
    let lastError: unknown = null;

    while (Date.now() < timeoutAt) {
      if (this.stopRequested) {
        throw new SidecarStartupCancelledError();
      }

      const exitError = this.getChildExitError(child);
      if (exitError) {
        throw exitError;
      }

      try {
        const response = await fetch(backend === "mlx" ? `${baseUrl}/v1/models` : `${baseUrl}/health`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (response.ok) {
          await this.waitForCompletionProbe(baseUrl, backend);
          return;
        }
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
        const latestExitError = this.getChildExitError(child);
        if (latestExitError) {
          throw latestExitError;
        }
      }

      await delay(backend === "mlx" ? 1_000 : 500);
    }

    if (this.stopRequested) {
      throw new SidecarStartupCancelledError();
    }

    const exitError = this.getChildExitError(child);
    if (exitError) {
      throw exitError;
    }

    if (lastError instanceof Error) {
      logger.warn(lastError, "[sidecar] Readiness probe timed out after repeated failures");
    }
    throw new SidecarStartupTimeoutError();
  }

  private async stopUnlocked(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.cleanupChildState();
      return;
    }

    this.intentionalStop = true;
    const exited =
      child.exitCode === null
        ? new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
          })
        : Promise.resolve();

    try {
      child.kill("SIGTERM");
    } catch {
      // Best-effort shutdown.
    }

    const timeout = delay(5_000);
    await Promise.race([exited, timeout]);

    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best-effort forced shutdown.
      }
    }

    this.cleanupChildState(child);
  }

  private cleanupChildState(child?: ChildProcess): void {
    if (child && this.child !== child) {
      return;
    }

    const currentChild = this.child;
    currentChild?.stdout?.removeAllListeners("data");
    currentChild?.stderr?.removeAllListeners("data");
    currentChild?.removeAllListeners("error");
    currentChild?.removeAllListeners("exit");
    this.child = null;
    this.ready = false;
    this.baseUrl = null;
    this.currentSignature = null;
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }

  private async handleChildExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (this.child !== child) {
      return;
    }

    const wasIntentional = this.intentionalStop || this.stopRequested;
    this.intentionalStop = false;
    this.cleanupChildState(child);

    const state = this.childStates.get(child);
    logEvent(
      wasIntentional ? "info" : "warn",
      "sidecar.exit",
      {
        pid: child.pid,
        exitCode: code,
        signal,
        uptimeMs: state ? Date.now() - state.startedAt : undefined,
        variant: state?.variant,
        expected: wasIntentional,
        ...(wasIntentional ? {} : { stderrTail: stderrTailOf(state) }),
      },
      wasIntentional ? "[sidecar] Local sidecar server exited" : "[sidecar] Local sidecar server exited unexpectedly",
    );

    if (wasIntentional) {
      return;
    }

    if (this.starting) {
      return;
    }

    const now = Date.now();
    const withinRepeatedCrashWindow =
      this.unexpectedCrashWindowStartedAt > 0 && now - this.unexpectedCrashWindowStartedAt < CRASH_WINDOW_MS;
    if (!withinRepeatedCrashWindow) {
      this.unexpectedCrashWindowStartedAt = now;
      this.unexpectedCrashCount = 1;
    } else {
      this.unexpectedCrashCount += 1;
    }

    if (this.unexpectedCrashCount > 1) {
      logEvent(
        "error",
        "sidecar.crashloop",
        { crashCount: this.unexpectedCrashCount, windowMs: CRASH_WINDOW_MS, variant: state?.variant },
        "[sidecar] Local sidecar server crashed repeatedly; auto-restart stopped",
      );
      this.startupError = "The local sidecar server crashed repeatedly after startup";
      sidecarModelService.setStatus("server_error");
      return;
    }

    try {
      await this.syncForCurrentConfig({ allowRuntimeInstall: false });
    } catch (error) {
      logger.error(error, "[sidecar] Auto-restart failed");
      sidecarModelService.setStatus("server_error");
    }
  }
}

export const sidecarProcessService = new SidecarProcessService();
registerWorkerGauge("sidecar", () => sidecarProcessService.sampleGauge());

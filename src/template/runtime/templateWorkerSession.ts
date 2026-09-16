import type { TemplateWorkspaceFiles } from "./compiler";
import type {
  ConfigFieldDescriptor,
  RuntimeOutputProfile,
  WorkerDoneMessage,
  WorkerIncomingMessage,
  WorkerOutgoingMessage,
} from "./workerProtocol";
import type { RuntimeLogger } from "./sharedTemplateRunner";

export interface RuntimeResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface TemplateWorkerSessionOptions {
  files: TemplateWorkspaceFiles;
  entry?: string;
  logger?: RuntimeLogger;
  forceSoftwareWebCodecs?: boolean;
}

function makeRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class TemplateWorkerSession {
  private readonly options: TemplateWorkerSessionOptions;

  private worker: Worker;

  private logger: RuntimeLogger;

  private disposed = false;

  private readonly bridgePrefix = "[template-worker]";

  private readonly pendingResolvers = new Map<
    string,
    (result: WorkerDoneMessage["result"]) => void
  >();

  constructor(options: TemplateWorkerSessionOptions) {
    this.options = options;
    this.worker = new Worker(new URL("../../workers/templateRuntime.worker.ts", import.meta.url), {
      type: "module",
    });
    this.logger =
      options.logger ??
      ({
        info: (...args: unknown[]) => console.info("[template-worker]", ...args),
        error: (...args: unknown[]) => console.error("[template-worker]", ...args),
        progress: (percent: number) => console.info("[template-worker][progress]", percent),
      } satisfies RuntimeLogger);
  }

  private bridgeLogToConsole(requestId: string, level: "info" | "error", args: unknown[]) {
    const prefix = `${this.bridgePrefix}[${requestId}]`;
    if (level === "error") {
      console.error(prefix, ...args);
      return;
    }
    console.info(prefix, ...args);
  }

  private bridgeProgressToConsole(requestId: string, percent: number) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    console.info(`${this.bridgePrefix}[${requestId}][progress]`, `${clamped}%`);
  }

  private request(message: WorkerIncomingMessage): Promise<WorkerDoneMessage["result"]> {
    if (this.disposed) {
      return Promise.resolve({ ok: false, error: "TemplateWorkerSession 已释放" });
    }

    return new Promise<WorkerDoneMessage["result"]>((resolve) => {
      this.pendingResolvers.set(message.requestId, resolve);

      const onMessage = (event: MessageEvent<WorkerOutgoingMessage>) => {
        const data = event.data;
        if (!data || data.requestId !== message.requestId) return;

        if (data.type === "log") {
          this.bridgeLogToConsole(data.requestId, data.level, data.args);
          if (data.level === "error") {
            this.logger.error(...data.args);
          } else {
            this.logger.info(...data.args);
          }
          return;
        }

        if (data.type === "progress") {
          this.bridgeProgressToConsole(data.requestId, data.percent);
          this.logger.progress?.(data.percent);
          return;
        }

        if (data.type === "done") {
          this.worker.removeEventListener("message", onMessage as EventListener);
          this.pendingResolvers.delete(message.requestId);
          resolve(data.result);
        }
      };

      this.worker.addEventListener("message", onMessage as EventListener);
      this.worker.postMessage(message);
    });
  }

  async initialize(): Promise<{
    ok: boolean;
    configFields: ConfigFieldDescriptor[];
    error?: string;
  }> {
    const requestId = makeRequestId("init-template");
    const result = await this.request({
      type: "init-template",
      requestId,
      payload: {
        files: this.options.files,
        entry: this.options.entry ?? "index.ts",
      },
    });

    return {
      ok: result.ok,
      configFields: result.configFields ?? [],
      error: result.error,
    };
  }

  async evaluate(config?: Record<string, unknown>): Promise<{
    ok: boolean;
    configFields: ConfigFieldDescriptor[];
    normalizedConfig: Record<string, unknown>;
    error?: string;
  }> {
    const requestId = makeRequestId("evaluate-config");
    const result = await this.request({
      type: "evaluate-config",
      requestId,
      payload: { config },
    });

    return {
      ok: result.ok,
      configFields: result.configFields ?? [],
      normalizedConfig: result.normalizedConfig ?? {},
      error: result.error,
    };
  }

  async run(
    config?: Record<string, unknown>,
    mediaFile?: File,
    maxDurationMilliseconds?: number,
    outputProfile?: RuntimeOutputProfile,
  ): Promise<RuntimeResult> {
    const requestId = makeRequestId("run-template");
    const result = await this.request({
      type: "run-template",
      requestId,
      payload: {
        config,
        mediaFile,
        maxDurationMilliseconds,
        outputProfile,
        forceSoftwareWebCodecs: this.options.forceSoftwareWebCodecs,
      },
    });

    return { ok: result.ok, value: result.value, error: result.error };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const pending = Array.from(this.pendingResolvers.values());
    this.pendingResolvers.clear();
    for (const resolve of pending) {
      resolve({ ok: false, error: "TemplateWorkerSession 已释放" });
    }

    const requestId = makeRequestId("dispose-template");
    this.worker.postMessage({
      type: "dispose-template",
      requestId,
    } satisfies WorkerIncomingMessage);
    this.worker.terminate();
  }
}

export async function runTemplateInWorker(
  options: {
    files: TemplateWorkspaceFiles;
    entry?: string;
    config?: Record<string, unknown>;
    mediaFile?: File;
    maxDurationMilliseconds?: number;
    outputProfile?: RuntimeOutputProfile;
  },
  logger: RuntimeLogger,
): Promise<RuntimeResult> {
  const session = new TemplateWorkerSession({ files: options.files, entry: options.entry, logger });
  const initialized = await session.initialize();
  if (!initialized.ok) {
    await session.dispose();
    return { ok: false, error: initialized.error ?? "模板初始化失败" };
  }

  const result = await session.run(
    options.config,
    options.mediaFile,
    options.maxDurationMilliseconds,
    options.outputProfile,
  );
  await session.dispose();
  return result;
}

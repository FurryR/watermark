import type { TemplateWorkspaceFiles } from "./compiler";
import {
  evaluateTemplateConfig,
  executeTemplateApp,
  extractTemplateConfigFields,
  loadTemplateModule,
  serializeSchemaField,
  type RuntimeLogger,
} from "./sharedTemplateRunner";
import {
  TemplateWorkerSession,
  runTemplateInWorker,
  type RuntimeResult,
  type TemplateWorkerSessionOptions,
} from "./templateWorkerSession";
import type { ConfigFieldDescriptor, RuntimeOutputProfile } from "./workerProtocol";

export type { RuntimeLogger };
export { TemplateWorkerSession, runTemplateInWorker };
export type { RuntimeResult, TemplateWorkerSessionOptions };

export interface RuntimeEvaluateResult {
  ok: boolean;
  configFields: ConfigFieldDescriptor[];
  normalizedConfig: Record<string, unknown>;
  error?: string;
}

export interface RuntimeInitResult {
  ok: boolean;
  configFields: ConfigFieldDescriptor[];
  error?: string;
}

export interface TemplateRuntimeSession {
  initialize(): Promise<RuntimeInitResult>;
  evaluate(config?: Record<string, unknown>): Promise<RuntimeEvaluateResult>;
  run(
    config?: Record<string, unknown>,
    mediaFile?: File,
    maxDurationMilliseconds?: number,
    signal?: AbortSignal,
    outputProfile?: RuntimeOutputProfile,
  ): Promise<RuntimeResult>;
  dispose(): Promise<void>;
}

class MainThreadRuntimeSession implements TemplateRuntimeSession {
  private disposed = false;

  private app: Awaited<ReturnType<typeof loadTemplateModule>>["app"] | undefined;

  private schemaFields: ReturnType<typeof extractTemplateConfigFields> = [];

  private readonly options: {
    files: TemplateWorkspaceFiles;
    entry?: string;
    logger?: RuntimeLogger;
    logPrefix?: string;
    forceSoftwareWebCodecs?: boolean;
  };

  constructor(options: {
    files: TemplateWorkspaceFiles;
    entry?: string;
    logger?: RuntimeLogger;
    logPrefix?: string;
    forceSoftwareWebCodecs?: boolean;
  }) {
    this.options = options;
  }

  private getLogger() {
    const prefix = this.options.logPrefix ?? "template-main-thread";
    return (
      this.options.logger ??
      ({
        info: (...args: unknown[]) => console.info(`[${prefix}]`, ...args),
        error: (...args: unknown[]) => console.error(`[${prefix}]`, ...args),
        progress: () => undefined,
      } satisfies RuntimeLogger)
    );
  }

  private async ensureLoaded() {
    if (this.disposed) {
      return { ok: false, error: "Runtime session 已释放" } as const;
    }

    if (this.app) {
      return { ok: true } as const;
    }

    const module = await loadTemplateModule(this.options.files, this.options.entry ?? "index.ts");
    this.app = module.app;
    this.schemaFields = extractTemplateConfigFields(module.configCtor);
    return { ok: true } as const;
  }

  async initialize(): Promise<RuntimeInitResult> {
    try {
      const loaded = await this.ensureLoaded();
      if (!loaded.ok) {
        return { ok: false, configFields: [], error: loaded.error };
      }
      return {
        ok: true,
        configFields: this.schemaFields.map(serializeSchemaField),
      };
    } catch (error) {
      return {
        ok: false,
        configFields: [],
        error: error instanceof Error ? error.message : "模板初始化失败",
      };
    }
  }

  async evaluate(config?: Record<string, unknown>): Promise<RuntimeEvaluateResult> {
    try {
      const loaded = await this.ensureLoaded();
      if (!loaded.ok) {
        return { ok: false, configFields: [], normalizedConfig: {}, error: loaded.error };
      }

      const evaluated = evaluateTemplateConfig(this.schemaFields, config);
      return {
        ok: true,
        configFields: evaluated.configFields,
        normalizedConfig: evaluated.normalizedConfig,
      };
    } catch (error) {
      return {
        ok: false,
        configFields: [],
        normalizedConfig: {},
        error: error instanceof Error ? error.message : "模板参数评估失败",
      };
    }
  }

  async run(
    config?: Record<string, unknown>,
    mediaFile?: File,
    maxDurationMilliseconds?: number,
    signal?: AbortSignal,
    outputProfile?: RuntimeOutputProfile,
  ): Promise<RuntimeResult> {
    try {
      const loaded = await this.ensureLoaded();
      if (!loaded.ok || !this.app) {
        return { ok: false, error: loaded.ok ? "模板初始化失败" : loaded.error };
      }

      const value = await executeTemplateApp({
        app: this.app,
        config,
        mediaFile,
        maxDurationMilliseconds,
        outputProfile,
        logger: this.getLogger(),
        signal,
        forceSoftwareWebCodecs: this.options.forceSoftwareWebCodecs,
      });
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "模板执行失败",
      };
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.app = undefined;
    this.schemaFields = [];
  }
}

class WorkerRuntimeSessionAdapter implements TemplateRuntimeSession {
  private readonly session: TemplateWorkerSession;

  constructor(session: TemplateWorkerSession) {
    this.session = session;
  }

  async initialize(): Promise<RuntimeInitResult> {
    return this.session.initialize();
  }

  async evaluate(config?: Record<string, unknown>): Promise<RuntimeEvaluateResult> {
    return this.session.evaluate(config);
  }

  async run(
    config?: Record<string, unknown>,
    mediaFile?: File,
    maxDurationMilliseconds?: number,
    _signal?: AbortSignal,
    outputProfile?: RuntimeOutputProfile,
  ): Promise<RuntimeResult> {
    return this.session.run(config, mediaFile, maxDurationMilliseconds, outputProfile);
  }

  async dispose(): Promise<void> {
    await this.session.dispose();
  }
}

export function createTemplateRuntimeSession(options: {
  mode: "worker" | "main-thread";
  files: TemplateWorkspaceFiles;
  entry?: string;
  logger?: RuntimeLogger;
  logPrefix?: string;
  forceSoftwareWebCodecs?: boolean;
}): TemplateRuntimeSession {
  if (options.mode === "worker") {
    const workerSession = new TemplateWorkerSession({
      files: options.files,
      entry: options.entry,
      logger: options.logger,
      forceSoftwareWebCodecs: options.forceSoftwareWebCodecs,
    });
    return new WorkerRuntimeSessionAdapter(workerSession);
  }

  return new MainThreadRuntimeSession(options);
}

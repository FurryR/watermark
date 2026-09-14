import {
  createTemplateRuntimeSession,
  type RuntimeResult,
  type TemplateRuntimeSession,
} from "./workerRunner";
import type { TemplateWorkspaceFiles } from "./compiler";
import type { RuntimeOutputProfile } from "./workerProtocol";
import type { RuntimeLogger } from "./sharedTemplateRunner";

export interface GenerationPoolOptions {
  mode: "worker" | "main-thread";
  files: TemplateWorkspaceFiles;
  entry?: string;
  logger: RuntimeLogger;
  maxConcurrency: number;
  outputProfile?: RuntimeOutputProfile;
}

/**
 * A lazily-grown pool of template runtime sessions.
 *
 * Sessions are created once and reused across multiple file runs, so the (expensive)
 * Babel compilation + PIXI environment setup only happens once per session instead of
 * once per file. Up to `maxConcurrency` sessions may be created in parallel, each
 * processing files sequentially.
 */
export class GenerationSessionPool {
  private readonly options: GenerationPoolOptions;

  private readonly sessions: TemplateRuntimeSession[] = [];

  private readonly initPromises: Array<Promise<boolean> | undefined> = [];

  private readonly available: number[] = [];

  private readonly waiting: Array<(index: number | null) => void> = [];

  private disposed = false;

  private initFailed = false;

  constructor(options: GenerationPoolOptions) {
    this.options = options;
  }

  private spawn(): number {
    const index = this.sessions.length;
    const session = createTemplateRuntimeSession({
      mode: this.options.mode,
      files: this.options.files,
      entry: this.options.entry ?? "index.ts",
      logger: this.options.logger,
      logPrefix: "template-main-thread-generate",
    });
    this.sessions.push(session);
    this.available.push(index);
    this.initPromises.push(undefined);
    return index;
  }

  private ensureInit(index: number): Promise<boolean> {
    if (this.initPromises[index]) {
      return this.initPromises[index] as Promise<boolean>;
    }
    const promise = this.sessions[index]
      .initialize()
      .then((result) => result.ok)
      .catch(() => false);
    this.initPromises[index] = promise;
    return promise;
  }

  private acquire(): Promise<number | null> {
    if (this.disposed) {
      return Promise.resolve(null);
    }

    if (this.available.length > 0) {
      return Promise.resolve(this.available.pop() as number);
    }

    if (this.sessions.length < this.options.maxConcurrency) {
      const index = this.spawn();
      return Promise.resolve(index);
    }

    return new Promise<number | null>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  private release(index: number) {
    if (this.disposed) return;
    const next = this.waiting.shift();
    if (next) {
      next(index);
      return;
    }
    this.available.push(index);
  } /**
   * Run a single media file through a pooled session. The session is reused; only
   * the per-file run is dispatched.
   */
  async run(options: {
    config: Record<string, unknown>;
    mediaFile: File;
    maxDurationMilliseconds?: number;
    signal?: AbortSignal;
    outputProfile?: RuntimeOutputProfile;
  }): Promise<RuntimeResult> {
    if (this.disposed) {
      return { ok: false, error: "生成会话池已释放" };
    }

    const index = await this.acquire();
    if (index === null) {
      return { ok: false, error: "生成会话池已释放" };
    }

    try {
      const initialized = await this.ensureInit(index);
      if (!initialized) {
        if (this.initFailed) {
          return { ok: false, error: "模板初始化失败" };
        }
        this.initFailed = true;
        return { ok: false, error: "模板初始化失败" };
      }

      const session = this.sessions[index];
      const result = await session.run(
        options.config,
        options.mediaFile,
        options.maxDurationMilliseconds,
        options.signal,
        options.outputProfile,
      );
      return result;
    } finally {
      this.release(index);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    for (const resolve of this.waiting.splice(0)) {
      resolve(null);
    }

    const sessions = this.sessions.splice(0);
    this.available.length = 0;
    await Promise.allSettled(sessions.map((session) => session.dispose()));
  }
}

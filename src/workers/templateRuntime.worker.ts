/// <reference lib="webworker" />

import {
  executeTemplateApp,
  evaluateTemplateConfig,
  extractTemplateConfigFields,
  loadTemplateModule,
  serializeSchemaField,
  type TemplateConfigCtor,
  type TemplateDefaultExport,
} from "../template/runtime/sharedTemplateRunner";
import type {
  ConfigFieldDescriptor,
  RuntimeOutputProfile,
} from "../template/runtime/workerProtocol";
import type {
  WorkerIncomingMessage,
  WorkerOutgoingMessage,
} from "../template/runtime/workerProtocol";

interface WorkerRuntimeState {
  app?: TemplateDefaultExport;
  configCtor?: TemplateConfigCtor;
  moduleOrder?: string[];
  schemaFields?: ReturnType<typeof extractTemplateConfigFields>;
}

const runtimeState: WorkerRuntimeState = {};

function postMessageSafe(message: WorkerOutgoingMessage) {
  self.postMessage(message);
}

function createLogger(requestId: string) {
  return {
    info: (...args: unknown[]) => {
      postMessageSafe({ type: "log", requestId, level: "info", args });
    },
    error: (...args: unknown[]) => {
      postMessageSafe({ type: "log", requestId, level: "error", args });
    },
    progress: (percent: number) => {
      postMessageSafe({ type: "progress", requestId, percent });
    },
  };
}

async function initializeTemplate(
  requestId: string,
  payload: { files: Record<string, string>; entry: string },
) {
  const logger = createLogger(requestId);
  logger.info("开始编译模板工作区");

  const module = await loadTemplateModule(payload.files, payload.entry);

  runtimeState.app = module.app;
  runtimeState.configCtor = module.configCtor;
  runtimeState.moduleOrder = module.moduleOrder;
  runtimeState.schemaFields = extractTemplateConfigFields(module.configCtor);

  logger.info("模板初始化完成", { modules: module.moduleOrder.length });

  const configFields: ConfigFieldDescriptor[] = runtimeState.schemaFields.map(serializeSchemaField);

  return {
    ok: true,
    configFields,
    moduleOrder: module.moduleOrder,
  };
}

async function evaluateConfig(requestId: string, payload: { config?: Record<string, unknown> }) {
  const logger = createLogger(requestId);
  if (!runtimeState.app || !runtimeState.schemaFields) {
    throw new Error("模板尚未初始化，请先调用 init-template");
  }

  const evaluated = evaluateTemplateConfig(runtimeState.schemaFields, payload.config);
  logger.info("模板参数评估完成", { fieldCount: evaluated.configFields.length });

  return {
    ok: true,
    configFields: evaluated.configFields,
    normalizedConfig: evaluated.normalizedConfig,
    moduleOrder: runtimeState.moduleOrder,
  };
}

async function runTemplate(
  requestId: string,
  payload: {
    config?: Record<string, unknown>;
    mediaFile?: File;
    maxDurationMilliseconds?: number;
    outputProfile?: RuntimeOutputProfile;
    forceSoftwareWebCodecs?: boolean;
  },
) {
  const logger = createLogger(requestId);
  if (!runtimeState.app) {
    throw new Error("模板尚未初始化，请先调用 init-template");
  }

  const rendered = await executeTemplateApp({
    app: runtimeState.app,
    config: payload.config,
    mediaFile: payload.mediaFile,
    maxDurationMilliseconds: payload.maxDurationMilliseconds,
    outputProfile: payload.outputProfile,
    forceSoftwareWebCodecs: payload.forceSoftwareWebCodecs,
    logger,
  });

  return {
    ok: true,
    value: rendered,
    moduleOrder: runtimeState.moduleOrder,
  };
}

self.onmessage = async (event: MessageEvent<WorkerIncomingMessage>) => {
  if (!event.data) return;

  const { requestId } = event.data;

  if (event.data.type === "dispose-template") {
    runtimeState.app = undefined;
    runtimeState.configCtor = undefined;
    runtimeState.moduleOrder = undefined;
    runtimeState.schemaFields = undefined;
    postMessageSafe({ type: "done", requestId, result: { ok: true } });
    return;
  }

  try {
    const result =
      event.data.type === "init-template"
        ? await initializeTemplate(requestId, event.data.payload)
        : event.data.type === "evaluate-config"
          ? await evaluateConfig(requestId, event.data.payload)
          : await runTemplate(requestId, event.data.payload);

    postMessageSafe({ type: "done", requestId, result });
  } catch (error) {
    postMessageSafe({
      type: "done",
      requestId,
      result: {
        ok: false,
        error: error instanceof Error ? error.message : "模板执行失败",
      },
    });
  }
};

export {};

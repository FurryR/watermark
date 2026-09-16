import type { TemplateWorkspaceFiles } from "./compiler";

export type RuntimeOutputProfile = "default" | "preview-fast";

export interface ConfigFieldDescriptor {
  key: string;
  name: string;
  description?: string;
  kind:
    | "string"
    | "number"
    | "boolean"
    | "enum"
    | "select"
    | "image"
    | "rgb"
    | "rgba"
    | "size"
    | "coord";
  required?: boolean;
  default?:
    | string
    | number
    | boolean
    | { r: number; g: number; b: number }
    | { r: number; g: number; b: number; a: number }
    | { width: number; height: number }
    | { x: number; y: number };
  options?: Array<{ label: string; value: string | number }>;
  group?: string;
  groupPath?: string[];
  gridIndex?: number;
}

export interface WorkerInitRequest {
  type: "init-template";
  requestId: string;
  payload: {
    files: TemplateWorkspaceFiles;
    entry: string;
  };
}

export interface WorkerRunRequest {
  type: "run-template";
  requestId: string;
  payload: {
    config?: Record<string, unknown>;
    mediaFile?: File;
    maxDurationMilliseconds?: number;
    outputProfile?: RuntimeOutputProfile;
    forceSoftwareWebCodecs?: boolean;
  };
}

export interface WorkerEvaluateRequest {
  type: "evaluate-config";
  requestId: string;
  payload: {
    config?: Record<string, unknown>;
  };
}

export interface WorkerDisposeRequest {
  type: "dispose-template";
  requestId: string;
}

export interface WorkerLogMessage {
  type: "log";
  requestId: string;
  level: "info" | "error";
  args: unknown[];
}

export interface WorkerProgressMessage {
  type: "progress";
  requestId: string;
  percent: number;
}

export interface WorkerDoneMessage {
  type: "done";
  requestId: string;
  result: {
    ok: boolean;
    value?: unknown;
    error?: string;
    moduleOrder?: string[];
    configFields?: ConfigFieldDescriptor[];
    normalizedConfig?: Record<string, unknown>;
  };
}

export type WorkerIncomingMessage =
  | WorkerInitRequest
  | WorkerRunRequest
  | WorkerEvaluateRequest
  | WorkerDisposeRequest;
export type WorkerOutgoingMessage = WorkerLogMessage | WorkerProgressMessage | WorkerDoneMessage;

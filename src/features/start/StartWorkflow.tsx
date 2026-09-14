import CloudUploadRoundedIcon from "@mui/icons-material/CloudUploadRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import ArrowBackIosNewRoundedIcon from "@mui/icons-material/ArrowBackIosNewRounded";
import ArrowForwardIosRoundedIcon from "@mui/icons-material/ArrowForwardIosRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import LockOpenRoundedIcon from "@mui/icons-material/LockOpenRounded";
import {
  Alert,
  CircularProgress,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Fab,
  LinearProgress,
  MenuItem,
  Switch,
  FormControlLabel,
  IconButton,
  Modal,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";
import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import { HexAlphaColorPicker } from "react-colorful";
import { builtInTemplates } from "./mockTemplates";
import { exportAsZip, simulateGenerate } from "./pipelineStub";
import type { GeneratedAsset, StepState, WatermarkTemplate } from "./types";
import { importTemplateZip } from "../../utils/zip/templateZip";
import { loadBuiltInTemplateWorkspace } from "./templates/builtInTemplateLoader";
import type { ConfigFieldDescriptor } from "../../template/runtime/workerProtocol";
import {
  createTemplateRuntimeSession,
  type RuntimeResult,
  type TemplateRuntimeSession,
} from "../../template/runtime/workerRunner";
import type { RuntimeOutputProfile } from "../../template/runtime/workerProtocol";
import { useRuntimeSettings } from "../settings/runtimeSettings";
import { useUnsavedChangesGuard } from "../../unsavedChangesGuard";
import { GenerationSessionPool } from "../../template/runtime/GenerationSessionPool";
import { mapConcurrency } from "../../utils/mapConcurrency";
import { throttleProgressUpdates } from "../../utils/throttleProgressUpdates";

const acceptTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
].join(",");

function isImage(file: File) {
  return file.type.startsWith("image/");
}

function mimeTypeToExtension(mimeType: string) {
  const normalizedMime = mimeType.split(";")[0]?.trim().toLowerCase() || "";
  switch (normalizedMime) {
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    case "image/png":
    default:
      return "png";
  }
}

function stripExtension(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "");
}

function getFileCacheKey(file: File) {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

interface FieldGroupNode {
  key: string;
  label: string;
  path: string[];
  fields: ConfigFieldDescriptor[];
  children: FieldGroupNode[];
}

interface TemplateConfigSnapshot {
  selectedTemplateId: string;
  params: Record<string, unknown>;
  normalizedParams: Record<string, unknown>;
  evaluatedFields: ConfigFieldDescriptor[];
}

function createEmptyTemplateConfigSnapshot(): TemplateConfigSnapshot {
  return {
    selectedTemplateId: "",
    params: {},
    normalizedParams: {},
    evaluatedFields: [],
  };
}

function isTemplateConfigSnapshotEqual(a: TemplateConfigSnapshot, b: TemplateConfigSnapshot) {
  return (
    a.selectedTemplateId === b.selectedTemplateId &&
    JSON.stringify(a.params) === JSON.stringify(b.params) &&
    JSON.stringify(a.normalizedParams) === JSON.stringify(b.normalizedParams) &&
    JSON.stringify(a.evaluatedFields) === JSON.stringify(b.evaluatedFields)
  );
}

function getFileMediaType(file: File): "image" | "video" {
  return file.type.startsWith("video/") ? "video" : "image";
}

function templateSupportsMedia(template: WatermarkTemplate, mediaType: "image" | "video") {
  return template.mediaType === "both" || template.mediaType === mediaType;
}

function hasMissingRequiredField(snapshot: TemplateConfigSnapshot) {
  return snapshot.evaluatedFields.some((field) => {
    if (!field.required) return false;
    const value = snapshot.normalizedParams[field.key];
    if (field.kind === "boolean") return value === undefined;
    return value === undefined || value === "";
  });
}

function checkWebCodecsSupport() {
  if (typeof window === "undefined") return true;
  return (
    "VideoEncoder" in window &&
    "VideoDecoder" in window &&
    "AudioEncoder" in window &&
    "AudioDecoder" in window &&
    "VideoFrame" in window &&
    "AudioData" in window &&
    "EncodedVideoChunk" in window &&
    "EncodedAudioChunk" in window
  );
}

function clampByte(value: unknown, fallback = 0) {
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(255, Math.round(numeric)));
}

function clampAlpha(value: unknown, fallback = 1) {
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, Number(numeric.toFixed(3))));
}

function toFiniteNumber(value: unknown, fallback = 0) {
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return numeric;
}

function parseHexToRgb(hexColor: string) {
  const raw = hexColor.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) {
    return { r: 0, g: 0, b: 0 };
  }
  const value = Number.parseInt(raw, 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

function toHexColor(r: number, g: number, b: number) {
  const value = (clampByte(r) << 16) | (clampByte(g) << 8) | clampByte(b);
  return `#${value.toString(16).padStart(6, "0")}`;
}

function readRgbValue(value: unknown) {
  const source = value as Record<string, unknown> | null | undefined;
  return {
    r: clampByte(source?.r, 255),
    g: clampByte(source?.g, 255),
    b: clampByte(source?.b, 255),
  };
}

function readRgbaValue(value: unknown) {
  const source = value as Record<string, unknown> | null | undefined;
  return {
    r: clampByte(source?.r, 255),
    g: clampByte(source?.g, 255),
    b: clampByte(source?.b, 255),
    a: clampAlpha(source?.a, 1),
  };
}

function toHexAlphaColor(value: { r: number; g: number; b: number; a: number }) {
  const alpha = Math.round(clampAlpha(value.a, 1) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${toHexColor(value.r, value.g, value.b)}${alpha}`;
}

function toCssRgbaColor(value: { r: number; g: number; b: number; a: number }) {
  const alpha = Number(clampAlpha(value.a, 1).toFixed(3));
  return `rgba(${clampByte(value.r)}, ${clampByte(value.g)}, ${clampByte(value.b)}, ${alpha})`;
}

function parseCssRgbaColor(input: string) {
  const normalized = input.trim().toLowerCase();
  const match = normalized.match(/^rgba?\((.*)\)$/i);
  if (!match) return undefined;

  const parts = match[1]
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length !== 3 && parts.length !== 4) {
    return undefined;
  }

  const r = clampByte(parts[0]);
  const g = clampByte(parts[1]);
  const b = clampByte(parts[2]);
  const a = parts.length === 4 ? clampAlpha(parts[3], 1) : 1;
  return { r, g, b, a };
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

function toSimplestRatio(width: number, height: number) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const d = gcd(w, h);
  return `${w / d}:${h / d}`;
}

function parseHexAlphaColor(hexColor: string) {
  const raw = hexColor.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(raw)) {
    return undefined;
  }

  const base = raw.slice(0, 6);
  const rgb = parseHexToRgb(base);
  const alphaRaw = raw.length === 8 ? Number.parseInt(raw.slice(6, 8), 16) / 255 : 1;
  return {
    ...rgb,
    a: clampAlpha(alphaRaw, 1),
  };
}

function readSizeValue(value: unknown) {
  const source = value as Record<string, unknown> | null | undefined;
  return {
    width: toFiniteNumber(source?.width, 0),
    height: toFiniteNumber(source?.height, 0),
  };
}

function readCoordValue(value: unknown) {
  const source = value as Record<string, unknown> | null | undefined;
  return {
    x: toFiniteNumber(source?.x, 0),
    y: toFiniteNumber(source?.y, 0),
  };
}

function toEditableValue(value: unknown): unknown {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  if ("r" in source && "g" in source && "b" in source && "a" in source) {
    return {
      r: clampByte(source.r, 255),
      g: clampByte(source.g, 255),
      b: clampByte(source.b, 255),
      a: clampAlpha(source.a, 1),
    };
  }
  if ("r" in source && "g" in source && "b" in source) {
    return {
      r: clampByte(source.r, 255),
      g: clampByte(source.g, 255),
      b: clampByte(source.b, 255),
    };
  }
  if ("width" in source && "height" in source) {
    return {
      width: toFiniteNumber(source.width, 0),
      height: toFiniteNumber(source.height, 0),
    };
  }
  if ("x" in source && "y" in source) {
    return {
      x: toFiniteNumber(source.x, 0),
      y: toFiniteNumber(source.y, 0),
    };
  }

  return undefined;
}

async function readTrackCodec(
  track: {
    codec?: string | null;
    getDecoderConfig?: () => Promise<{ codec?: string } | null>;
    canDecode?: () => Promise<boolean>;
  } | null,
) {
  if (!track) return "";
  if (typeof track.getDecoderConfig === "function") {
    try {
      const decoderConfig = await track.getDecoderConfig();
      const configCodec = decoderConfig?.codec?.trim();
      if (configCodec) return configCodec;
    } catch {
      // Ignore decoder config read errors and fallback to track codec.
    }
  }
  return track.codec?.trim() ?? "";
}

async function detectFileCodecSupport(file: File) {
  if (!file.type.startsWith("video/")) return true;

  const fileTag = `${file.name} (${file.type || "unknown"}, ${file.size} bytes)`;
  console.info("[media-codec-check] start", { file: fileTag });

  const inputFile = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });

  try {
    const [videoTrack, audioTrack] = await Promise.all([
      inputFile.getPrimaryVideoTrack(),
      inputFile.getPrimaryAudioTrack(),
    ]);

    const videoCodec = await readTrackCodec(
      videoTrack as {
        codec?: string | null;
        getDecoderConfig?: () => Promise<{ codec?: string } | null>;
        canDecode?: () => Promise<boolean>;
      } | null,
    );
    if (videoCodec) {
      const videoSupported =
        typeof videoTrack?.canDecode === "function" ? await videoTrack.canDecode() : true;
      if (!videoSupported) {
        console.warn("[media-codec-check] unsupported video codec", {
          file: fileTag,
          codec: videoCodec,
        });
        return false;
      }
    }

    const audioCodec = await readTrackCodec(
      audioTrack as {
        codec?: string | null;
        getDecoderConfig?: () => Promise<{ codec?: string } | null>;
        canDecode?: () => Promise<boolean>;
      } | null,
    );
    if (audioCodec) {
      const audioSupported =
        typeof audioTrack?.canDecode === "function" ? await audioTrack.canDecode() : true;
      if (!audioSupported) {
        console.warn("[media-codec-check] unsupported audio codec", {
          file: fileTag,
          codec: audioCodec,
        });
        return false;
      }
    }

    console.info("[media-codec-check] supported", { file: fileTag, videoCodec, audioCodec });
    return true;
  } catch (error) {
    console.error("[media-codec-check] failed to inspect codec; fallback to supported", {
      file: fileTag,
      error,
    });
    return true;
  } finally {
    inputFile.dispose();
  }
}

async function detectMediaDimensions(
  file: File,
): Promise<{ width: number; height: number } | null> {
  try {
    if (file.type.startsWith("image/")) {
      const bitmap = await createImageBitmap(file);
      const result = { width: Math.max(1, bitmap.width), height: Math.max(1, bitmap.height) };
      bitmap.close();
      return result;
    }

    if (file.type.startsWith("video/")) {
      const objectUrl = URL.createObjectURL(file);
      try {
        return await new Promise<{ width: number; height: number } | null>((resolve) => {
          const video = document.createElement("video");
          video.preload = "metadata";
          video.onloadedmetadata = () => {
            resolve({
              width: Math.max(1, video.videoWidth || 1920),
              height: Math.max(1, video.videoHeight || 1080),
            });
          };
          video.onerror = () => resolve(null);
          video.src = objectUrl;
        });
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    }
  } catch {
    return null;
  }

  return null;
}

function buildAssetName(file: File, blob: Blob, index: number) {
  const baseName = stripExtension(file.name || `asset-${index + 1}`);
  const fileType = (file.type || "").toLowerCase();
  const blobType = (blob.type || "").toLowerCase();
  const extension = fileType.startsWith("video/")
    ? mimeTypeToExtension(blobType || "video/mp4")
    : mimeTypeToExtension(blobType || fileType || "image/png");
  return `${index + 1}-${baseName}.${extension}`;
}

export function StartWorkflow() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const previewUrlRef = useRef("");
  const previewAbortControllerRef = useRef<AbortController | null>(null);
  const previewRuntimeSessionRef = useRef<TemplateRuntimeSession | null>(null);
  const evaluationSessionsRef = useRef<Map<string, TemplateRuntimeSession>>(new Map());
  const evaluateRequestIdRef = useRef(0);
  const previewProgressThrottlerRef = useRef<ReturnType<typeof throttleProgressUpdates> | null>(
    null,
  );
  const generateProgressThrottlerRef = useRef<ReturnType<typeof throttleProgressUpdates> | null>(
    null,
  );
  const generateLatestProgressRef = useRef<{
    overall: number;
    normalized: number;
    fileName: string;
  } | null>(null);
  const previewLatestProgressRef = useRef<{
    clamped: number;
    phaseLabel: string;
    fileName: string;
  } | null>(null);
  const { settings } = useRuntimeSettings();
  const { setNavigationBlocked, setHasUnsavedChanges } = useUnsavedChangesGuard();
  const [files, setFiles] = useState<File[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [templates, setTemplates] = useState<WatermarkTemplate[]>(builtInTemplates);
  const [templateWorkspaces, setTemplateWorkspaces] = useState<
    Record<string, Record<string, string>>
  >({});
  const [activeConfigTarget, setActiveConfigTarget] = useState<"global" | string>("global");
  const [globalTemplateConfig, setGlobalTemplateConfig] = useState<TemplateConfigSnapshot>(
    createEmptyTemplateConfigSnapshot(),
  );
  const [fileTemplateOverrides, setFileTemplateOverrides] = useState<
    Record<string, TemplateConfigSnapshot>
  >({});
  const [evaluatedFields, setEvaluatedFields] = useState<ConfigFieldDescriptor[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [normalizedParams, setNormalizedParams] = useState<Record<string, unknown>>({});
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [state, setState] = useState<StepState>("editing");
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState("等待开始");
  const [assets, setAssets] = useState<GeneratedAsset[]>([]);
  const [error, setError] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewKind, setPreviewKind] = useState<"image" | "video" | "">("");
  const [previewWatermarked, setPreviewWatermarked] = useState(false);
  const [fileCodecSupportMap, setFileCodecSupportMap] = useState<Record<string, boolean>>({});
  const [mediaDimensionMap, setMediaDimensionMap] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const [failedFiles, setFailedFiles] = useState<string[]>([]);
  const [previewProgress, setPreviewProgress] = useState(0);
  const [previewProgressMessage, setPreviewProgressMessage] = useState("");
  const [zoomOpen, setZoomOpen] = useState(false);
  const [openColorFieldKey, setOpenColorFieldKey] = useState<string | null>(null);
  const [colorInputDraftMap, setColorInputDraftMap] = useState<Record<string, string>>({});
  const [coordDraggingMap, setCoordDraggingMap] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [generationWarning, setGenerationWarning] = useState("");
  const [generationWarningOpen, setGenerationWarningOpen] = useState(false);
  const [isPointerAdjusting, setIsPointerAdjusting] = useState(false);
  const [sizeLockMap, setSizeLockMap] = useState<Record<string, boolean>>({});
  const previewRequestIdRef = useRef(0);
  const previewSignatureRef = useRef("");
  const previewActiveFileRef = useRef("");
  const isMainThreadDebugMode = settings.useMainThreadRender;
  const runtimeMode: "worker" | "main-thread" = isMainThreadDebugMode ? "main-thread" : "worker";

  const selectedTemplate = templates.find((item) => item.id === selectedTemplateId);
  const groupedVisibleSchemaFields = useMemo(() => {
    const roots: FieldGroupNode[] = [];
    const rootNode: FieldGroupNode = {
      key: "__root",
      label: "",
      path: [],
      fields: [],
      children: roots,
    };
    const groupMap = new Map<string, FieldGroupNode>([["__root", rootNode]]);

    for (const field of evaluatedFields) {
      const groupPath =
        field.groupPath?.map((item) => item.trim()).filter((item) => item.length > 0) ??
        (field.group?.trim() ? [field.group.trim()] : []);

      let current = rootNode;
      let currentKey = "__root";

      for (const segment of groupPath) {
        currentKey = `${currentKey}>${segment}`;
        let target = groupMap.get(currentKey);
        if (!target) {
          target = {
            key: currentKey,
            label: segment,
            path: [...current.path, segment],
            fields: [],
            children: [],
          };
          current.children.push(target);
          groupMap.set(currentKey, target);
        }
        current = target;
      }

      current.fields.push(field);
    }

    return {
      roots,
      ungroupedFields: rootNode.fields,
    };
  }, [evaluatedFields]);
  const availableTemplates = useMemo(() => {
    if (files.length === 0) {
      return templates;
    }

    if (activeConfigTarget === "global") {
      return templates.filter((template) =>
        files.every((file) => templateSupportsMedia(template, getFileMediaType(file))),
      );
    }

    const targetFile = files.find((file) => getFileCacheKey(file) === activeConfigTarget);
    if (!targetFile) {
      return templates;
    }

    const targetMediaType = getFileMediaType(targetFile);
    return templates.filter((template) => templateSupportsMedia(template, targetMediaType));
  }, [activeConfigTarget, files, templates]);

  const isParamComplete = useMemo(() => {
    if (!selectedTemplate) return false;
    return evaluatedFields.every((field) => {
      if (!field.required) return true;
      const value = normalizedParams[field.key];
      if (field.kind === "boolean") return value !== undefined;
      return value !== undefined && value !== "";
    });
  }, [normalizedParams, selectedTemplate, evaluatedFields]);

  const currentFile = files[activeIndex];
  const isGlobalSettingsView = activeConfigTarget === "global";
  const hasActiveOverride =
    activeConfigTarget !== "global" && Boolean(fileTemplateOverrides[activeConfigTarget]);
  const webCodecsSupported = checkWebCodecsSupport();
  const showUnsupportedWebCodecsWarning = Boolean(
    currentFile && currentFile.type.startsWith("video/") && !webCodecsSupported,
  );
  const activeMediaDimensions = currentFile
    ? mediaDimensionMap[getFileCacheKey(currentFile)]
    : undefined;
  const hasStartDraft =
    files.length > 0 || Boolean(selectedTemplateId) || Object.keys(params).length > 0;
  const previewSignature = useMemo(
    () => JSON.stringify({ params, activeIndex, selectedTemplateId, isMainThreadDebugMode }),
    [params, activeIndex, selectedTemplateId, isMainThreadDebugMode],
  );

  const currentEditingSnapshot = useMemo<TemplateConfigSnapshot>(
    () => ({
      selectedTemplateId,
      params,
      normalizedParams,
      evaluatedFields,
    }),
    [selectedTemplateId, params, normalizedParams, evaluatedFields],
  );

  const effectiveGlobalSnapshot = useMemo<TemplateConfigSnapshot>(
    () => (activeConfigTarget === "global" ? currentEditingSnapshot : globalTemplateConfig),
    [activeConfigTarget, currentEditingSnapshot, globalTemplateConfig],
  );

  const effectiveFileOverrides = useMemo(() => {
    const next = { ...fileTemplateOverrides };
    if (activeConfigTarget === "global") {
      return next;
    }
    if (isTemplateConfigSnapshotEqual(currentEditingSnapshot, effectiveGlobalSnapshot)) {
      delete next[activeConfigTarget];
      return next;
    }
    next[activeConfigTarget] = currentEditingSnapshot;
    return next;
  }, [activeConfigTarget, currentEditingSnapshot, effectiveGlobalSnapshot, fileTemplateOverrides]);

  const fileValidation = useMemo(() => {
    return files.map((file) => {
      const fileKey = getFileCacheKey(file);
      const snapshot = effectiveFileOverrides[fileKey] ?? effectiveGlobalSnapshot;
      const mediaType = getFileMediaType(file);
      const template = templates.find((item) => item.id === snapshot.selectedTemplateId);

      if (!template) {
        return {
          file,
          fileKey,
          valid: false,
          reason: "未选择模板",
        };
      }

      if (!templateSupportsMedia(template, mediaType)) {
        return {
          file,
          fileKey,
          valid: false,
          reason: "模板不支持该文件类型",
        };
      }

      if (hasMissingRequiredField(snapshot)) {
        return {
          file,
          fileKey,
          valid: false,
          reason: "必填参数未完成",
        };
      }

      return {
        file,
        fileKey,
        valid: true,
        reason: "",
      };
    });
  }, [files, effectiveFileOverrides, effectiveGlobalSnapshot, templates]);

  const invalidFileValidation = useMemo(
    () => fileValidation.filter((item) => !item.valid),
    [fileValidation],
  );

  const invalidFileReasonByKey = useMemo(() => {
    const map: Record<string, string> = {};
    for (const item of fileValidation) {
      if (!item.valid) {
        map[item.fileKey] = item.reason;
      }
    }
    return map;
  }, [fileValidation]);

  const canGenerate = files.length > 0 && invalidFileValidation.length === 0;
  const currentFileIssue = currentFile
    ? (invalidFileReasonByKey[getFileCacheKey(currentFile)] ?? "")
    : "";
  const canPreview =
    Boolean(currentFile) && Boolean(selectedTemplate) && isParamComplete && !currentFileIssue;

  function getCurrentTemplateConfigSnapshot(): TemplateConfigSnapshot {
    return {
      selectedTemplateId,
      params,
      normalizedParams,
      evaluatedFields,
    };
  }

  function applyTemplateConfigSnapshot(snapshot: TemplateConfigSnapshot) {
    setSelectedTemplateId(snapshot.selectedTemplateId);
    setParams(snapshot.params);
    setNormalizedParams(snapshot.normalizedParams);
    setEvaluatedFields(snapshot.evaluatedFields);
  }

  function switchToConfigTarget(target: "global" | string) {
    if (target === activeConfigTarget) return;

    const currentSnapshot = getCurrentTemplateConfigSnapshot();
    const latestGlobalSnapshot =
      activeConfigTarget === "global" ? currentSnapshot : globalTemplateConfig;

    if (activeConfigTarget === "global") {
      setGlobalTemplateConfig(currentSnapshot);
    } else {
      const activeKey = activeConfigTarget;
      setFileTemplateOverrides((prev) => {
        if (isTemplateConfigSnapshotEqual(currentSnapshot, latestGlobalSnapshot)) {
          if (!prev[activeKey]) return prev;
          const next = { ...prev };
          delete next[activeKey];
          return next;
        }
        return {
          ...prev,
          [activeKey]: currentSnapshot,
        };
      });
    }

    setActiveConfigTarget(target);
    if (target === "global") {
      applyTemplateConfigSnapshot(latestGlobalSnapshot);
      return;
    }
    applyTemplateConfigSnapshot(fileTemplateOverrides[target] ?? latestGlobalSnapshot);
  }

  function restoreActiveFileToGlobalConfig() {
    if (activeConfigTarget === "global") return;
    const target = activeConfigTarget;
    setFileTemplateOverrides((prev) => {
      if (!prev[target]) return prev;
      const next = { ...prev };
      delete next[target];
      return next;
    });
    applyTemplateConfigSnapshot(globalTemplateConfig);
  }

  function resetPreviewProgress() {
    setPreviewProgress(0);
    setPreviewProgressMessage("");
  }

  function updatePreviewProgress(percent: number) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    const fileName = previewActiveFileRef.current || currentFile?.name || "当前文件";
    const isVideo = (currentFile?.type ?? "").startsWith("video/");
    const phaseLabel = isVideo ? "帧处理中" : "处理中";
    previewLatestProgressRef.current = { clamped, phaseLabel, fileName };

    if (!previewProgressThrottlerRef.current) {
      previewProgressThrottlerRef.current = throttleProgressUpdates(() => {
        const latest = previewLatestProgressRef.current;
        if (!latest) return;
        setPreviewProgress(latest.clamped);
        setPreviewProgressMessage(
          `正在${latest.phaseLabel} ${latest.fileName} (${latest.clamped}%)`,
        );
      });
    }
    previewProgressThrottlerRef.current.push(clamped);
  }

  function cleanupPreviewUrl(targetUrl?: string) {
    const urlToRevoke = targetUrl ?? previewUrlRef.current;
    if (!urlToRevoke) return;
    URL.revokeObjectURL(urlToRevoke);
    if (!targetUrl || targetUrl === previewUrlRef.current) {
      previewUrlRef.current = "";
    }
  }

  async function resolveWorkspaceFiles(template: WatermarkTemplate) {
    return (
      templateWorkspaces[template.id] ??
      (template.builtInWorkspaceId
        ? await loadBuiltInTemplateWorkspace(template.builtInWorkspaceId)
        : null)
    );
  }

  function notifyGenerationFinished(fileCount: number) {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return;
    }

    const title = "水印生成完成";
    const body = fileCount > 1 ? `已完成 ${fileCount} 个文件的生成。` : "已完成 1 个文件的生成。";

    const show = () => {
      try {
        new Notification(title, { body });
      } catch {
        // Ignore notification delivery errors.
      }
    };

    if (Notification.permission === "granted") {
      show();
      return;
    }

    if (Notification.permission === "default") {
      void Notification.requestPermission().then((permission) => {
        if (permission === "granted") {
          show();
        }
      });
    }
  }

  async function ensureNotificationPermissionBeforeGeneration() {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return;
    }

    if (Notification.permission !== "default") {
      return;
    }

    try {
      await Notification.requestPermission();
    } catch {
      // Ignore permission request failures.
    }
  }

  async function toDataUri(file: File): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
          return;
        }
        reject(new Error("图片读取失败"));
      };
      reader.onerror = () => reject(new Error("图片读取失败"));
      reader.readAsDataURL(file);
    });
  }

  async function applyImageFieldFile(fieldKey: string, file: File) {
    if (!isImage(file)) {
      setError("仅支持上传图片文件");
      return;
    }

    try {
      const dataUri = await toDataUri(file);
      setParams((prev) => ({
        ...prev,
        [fieldKey]: dataUri,
      }));
      setError("");
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "图片读取失败");
    }
  }

  async function onImageFieldDrop(fieldKey: string, input: FileList | null) {
    const selectedImage = input?.[0];
    if (!selectedImage) return;
    await applyImageFieldFile(fieldKey, selectedImage);
  }

  function getFieldValue(key: string) {
    return params[key] ?? normalizedParams[key] ?? "";
  }

  function getResolutionBase() {
    return {
      width: Math.max(1, activeMediaDimensions?.width ?? 1920),
      height: Math.max(1, activeMediaDimensions?.height ?? 1080),
    };
  }

  function updateCoordField(fieldKey: string, x: number, y: number) {
    if (currentFile && !activeMediaDimensions) {
      return;
    }

    const { width, height } = getResolutionBase();
    const nextX = Number(Math.max(0, Math.min(width, x)).toFixed(2));
    const nextY = Number(Math.max(0, Math.min(height, y)).toFixed(2));

    setParams((prev) => ({
      ...prev,
      [fieldKey]: {
        x: nextX,
        y: nextY,
      },
    }));
  }

  function updateSizeField(fieldKey: string, width: number, height: number) {
    setParams((prev) => ({
      ...prev,
      [fieldKey]: {
        width: Math.max(0, Number(width.toFixed(2))),
        height: Math.max(0, Number(height.toFixed(2))),
      },
    }));
  }

  async function cancelActivePreview() {
    previewAbortControllerRef.current?.abort();
    previewAbortControllerRef.current = null;

    const runningPreviewSession = previewRuntimeSessionRef.current;
    previewRuntimeSessionRef.current = null;
    if (runningPreviewSession) {
      await runningPreviewSession.dispose();
    }
  }

  async function disposeEvaluationSession() {
    const sessions = evaluationSessionsRef.current;
    evaluationSessionsRef.current = new Map();
    await Promise.allSettled(Array.from(sessions.values()).map((session) => session.dispose()));
  }

  async function ensureEvaluationSession(
    template: WatermarkTemplate,
    workspaceFiles: Record<string, string>,
  ) {
    const cache = evaluationSessionsRef.current;
    const cached = cache.get(template.id);
    if (cached) {
      return cached;
    }

    const evaluationSession = createTemplateRuntimeSession({
      mode: runtimeMode,
      files: workspaceFiles,
      entry: "index.ts",
      logger: {
        info: (...args: unknown[]) => console.info("[template-runtime][evaluate]", ...args),
        error: (...args: unknown[]) => console.error("[template-runtime][evaluate]", ...args),
      },
      logPrefix: "template-main-thread-evaluate",
    });

    const initialized = await evaluationSession.initialize();
    if (!initialized.ok) {
      await evaluationSession.dispose();
      throw new Error(initialized.error ?? `模板 ${template.name} 初始化失败`);
    }

    cache.set(template.id, evaluationSession);
    return evaluationSession;
  }

  async function evaluateParamsUsingRuntime(config: Record<string, unknown>) {
    if (!selectedTemplate) {
      return { ok: false, error: "未选择模板" } as const;
    }

    const workspaceFiles = await resolveWorkspaceFiles(selectedTemplate);
    if (!workspaceFiles) {
      return {
        ok: true,
        normalizedConfig: config,
        configFields: selectedTemplate.fields.map((field) => ({
          key: field.key,
          name: field.label,
          description: field.description,
          kind: field.type,
          required: field.required,
          default: field.defaultValue,
          options: field.options,
          group: field.group,
          groupPath: field.groupPath,
          gridIndex: field.gridIndex,
        })),
      } as const;
    }

    const session = await ensureEvaluationSession(selectedTemplate, workspaceFiles);
    return session.evaluate(config);
  }

  function toEditableParams(config: Record<string, unknown>) {
    const editable: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      const editableValue = toEditableValue(value);
      if (editableValue !== undefined) {
        editable[key] = editableValue;
      }
    }
    return editable;
  }

  async function initializeTemplateEvaluation(
    template: WatermarkTemplate,
    workspaceFiles: Record<string, string> | null,
  ) {
    await disposeEvaluationSession();

    if (!workspaceFiles) {
      const fallbackFields: ConfigFieldDescriptor[] = template.fields.map((field) => ({
        key: field.key,
        name: field.label,
        description: field.description,
        kind: field.type,
        required: field.required,
        default: field.defaultValue,
        options: field.options,
        group: field.group,
        groupPath: field.groupPath,
        gridIndex: field.gridIndex,
      }));
      const fallbackConfig: Record<string, unknown> = {};
      for (const field of fallbackFields) {
        if (field.default !== undefined) {
          fallbackConfig[field.key] = field.default;
        } else if (field.kind === "boolean") {
          fallbackConfig[field.key] = false;
        }
      }
      setEvaluatedFields(fallbackFields);
      setNormalizedParams(fallbackConfig);
      setParams(toEditableParams(fallbackConfig));
      return;
    }

    const session = createTemplateRuntimeSession({
      mode: runtimeMode,
      files: workspaceFiles,
      entry: "index.ts",
      logger: {
        info: (...args: unknown[]) => console.info("[template-runtime][evaluate]", ...args),
        error: (...args: unknown[]) => console.error("[template-runtime][evaluate]", ...args),
      },
      logPrefix: "template-main-thread-evaluate",
    });

    const initialized = await session.initialize();
    if (!initialized.ok) {
      await session.dispose();
      throw new Error(initialized.error ?? "模板初始化失败");
    }

    const evaluated = await session.evaluate({});
    if (!evaluated.ok) {
      await session.dispose();
      throw new Error(evaluated.error ?? "模板参数评估失败");
    }

    evaluationSessionsRef.current.set(template.id, session);
    setEvaluatedFields(evaluated.configFields);
    setNormalizedParams(evaluated.normalizedConfig);
    setParams(toEditableParams(evaluated.normalizedConfig));
  }

  function setPreviewSource(nextUrl: string, kind: "image" | "video", watermarked: boolean) {
    cleanupPreviewUrl(previewUrlRef.current);
    previewUrlRef.current = nextUrl;
    setPreviewUrl(nextUrl);
    setPreviewKind(kind);
    setPreviewWatermarked(watermarked);
    resetPreviewProgress();
  }

  async function runTemplateWithSelectedRuntime(options: {
    workspaceFiles: Record<string, string>;
    mediaFile: File;
    maxDurationMilliseconds?: number;
    loggerScope: string;
    updateProgress: (percent: number) => void;
    config: Record<string, unknown>;
    signal?: AbortSignal;
    outputProfile?: RuntimeOutputProfile;
  }): Promise<RuntimeResult> {
    const runtimeLogger = {
      info: (...args: unknown[]) =>
        console.info(`[template-runtime][${options.loggerScope}]`, ...args),
      error: (...args: unknown[]) =>
        console.error(`[template-runtime][${options.loggerScope}]`, ...args),
      progress: (percent: number) => options.updateProgress(percent),
    };

    const previewSession = createTemplateRuntimeSession({
      mode: runtimeMode,
      files: options.workspaceFiles,
      entry: "index.ts",
      logger: runtimeLogger,
      logPrefix: "template-main-thread",
    });
    previewRuntimeSessionRef.current = previewSession;

    try {
      const initialized = await previewSession.initialize();
      if (!initialized.ok) {
        return { ok: false, error: initialized.error ?? "模板初始化失败" };
      }

      return await previewSession.run(
        options.config,
        options.mediaFile,
        options.maxDurationMilliseconds,
        options.signal,
        options.outputProfile,
      );
    } finally {
      if (previewRuntimeSessionRef.current === previewSession) {
        previewRuntimeSessionRef.current = null;
      }
      await previewSession.dispose();
    }
  }

  async function onPreview() {
    if (!currentFile || !selectedTemplate) return;

    const requestId = ++previewRequestIdRef.current;
    await cancelActivePreview();
    const controller = new AbortController();
    previewAbortControllerRef.current = controller;
    previewSignatureRef.current = previewSignature;

    setPreviewLoading(true);
    setPreviewError("");
    previewActiveFileRef.current = currentFile.name;
    resetPreviewProgress();

    try {
      const workspaceFiles = await resolveWorkspaceFiles(selectedTemplate);
      if (!workspaceFiles) {
        const sourceUrl = URL.createObjectURL(currentFile);
        setPreviewSource(sourceUrl, isImage(currentFile) ? "image" : "video", false);
        return;
      }

      const evaluated = await evaluateParamsUsingRuntime(params);
      if (!evaluated.ok) {
        throw new Error(evaluated.error ?? "模板参数评估失败");
      }
      setEvaluatedFields(evaluated.configFields);
      setNormalizedParams(evaluated.normalizedConfig);

      const runtimeResult = await runTemplateWithSelectedRuntime({
        workspaceFiles,
        mediaFile: currentFile,
        maxDurationMilliseconds: 5000,
        outputProfile: "preview-fast",
        loggerScope: "preview",
        updateProgress: updatePreviewProgress,
        config: evaluated.normalizedConfig,
        signal: controller.signal,
      });

      if (controller.signal.aborted || previewRequestIdRef.current !== requestId) {
        return;
      }

      if (!runtimeResult.ok) {
        if (runtimeResult.error === "模板执行已取消") {
          return;
        }
        console.error("[start-workflow][preview] runtime returned error", {
          file: currentFile.name,
          runtimeResult,
        });
        throw new Error(runtimeResult.error ?? "预览生成失败");
      }

      const outputBlob = runtimeResult.value instanceof Blob ? runtimeResult.value : null;
      if (!outputBlob) {
        throw new Error("预览输出不是有效媒体");
      }

      const generatedUrl = URL.createObjectURL(outputBlob);
      if (previewRequestIdRef.current !== requestId) {
        URL.revokeObjectURL(generatedUrl);
        return;
      }
      const kind = outputBlob.type.startsWith("video/") ? "video" : "image";
      setPreviewSource(generatedUrl, kind, true);
    } catch (previewErr) {
      if (controller.signal.aborted || previewRequestIdRef.current !== requestId) {
        return;
      }
      console.error("[start-workflow][preview] failed", {
        file: currentFile.name,
        error: previewErr,
      });
      setPreviewError(previewErr instanceof Error ? previewErr.message : "预览生成失败");
    } finally {
      if (previewAbortControllerRef.current === controller) {
        previewAbortControllerRef.current = null;
      }
      if (previewRequestIdRef.current === requestId) {
        setPreviewLoading(false);
        previewActiveFileRef.current = "";
      }
    }
  }

  function removeFile(index: number) {
    const removedFile = files[index];
    const removedKey = removedFile ? getFileCacheKey(removedFile) : "";

    setFiles((prev) => {
      const next = prev.filter((_, idx) => idx !== index);
      setActiveIndex((current) => {
        if (next.length === 0) return 0;
        if (current > index) return current - 1;
        return Math.min(current, next.length - 1);
      });
      return next;
    });

    if (removedKey) {
      setFileTemplateOverrides((prev) => {
        if (!prev[removedKey]) return prev;
        const next = { ...prev };
        delete next[removedKey];
        return next;
      });
    }

    const nextFileCount = files.length - 1;
    if (nextFileCount <= 0) {
      const empty = createEmptyTemplateConfigSnapshot();
      setActiveConfigTarget("global");
      setGlobalTemplateConfig(empty);
      setFileTemplateOverrides({});
      applyTemplateConfigSnapshot(empty);
    } else if (removedKey && activeConfigTarget === removedKey) {
      switchToConfigTarget("global");
    }

    setFileCodecSupportMap((prev) => {
      const nextMap: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (files.some((file, idx) => idx !== index && getFileCacheKey(file) === key)) {
          nextMap[key] = value;
        }
      }
      return nextMap;
    });

    setMediaDimensionMap((prev) => {
      const nextMap: Record<string, { width: number; height: number }> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (files.some((file, idx) => idx !== index && getFileCacheKey(file) === key)) {
          nextMap[key] = value;
        }
      }
      return nextMap;
    });
  }

  useEffect(() => {
    return () => {
      cleanupPreviewUrl();
      void cancelActivePreview();
      void disposeEvaluationSession();
      previewProgressThrottlerRef.current?.cancel();
      generateProgressThrottlerRef.current?.cancel();
    };
  }, []);

  useEffect(() => {
    const currentSnapshot: TemplateConfigSnapshot = {
      selectedTemplateId,
      params,
      normalizedParams,
      evaluatedFields,
    };
    if (activeConfigTarget === "global") {
      setGlobalTemplateConfig((prev) =>
        isTemplateConfigSnapshotEqual(prev, currentSnapshot) ? prev : currentSnapshot,
      );
      return;
    }

    setFileTemplateOverrides((prev) => {
      if (isTemplateConfigSnapshotEqual(currentSnapshot, globalTemplateConfig)) {
        if (!prev[activeConfigTarget]) return prev;
        const next = { ...prev };
        delete next[activeConfigTarget];
        return next;
      }

      const existing = prev[activeConfigTarget];
      if (existing && isTemplateConfigSnapshotEqual(existing, currentSnapshot)) {
        return prev;
      }
      return {
        ...prev,
        [activeConfigTarget]: currentSnapshot,
      };
    });
  }, [
    activeConfigTarget,
    selectedTemplateId,
    params,
    normalizedParams,
    evaluatedFields,
    globalTemplateConfig,
  ]);

  useEffect(() => {
    setNavigationBlocked(state === "processing");
  }, [state, setNavigationBlocked]);

  useEffect(() => {
    setHasUnsavedChanges(hasStartDraft);
  }, [hasStartDraft, setHasUnsavedChanges]);

  useEffect(() => {
    return () => {
      setNavigationBlocked(false);
      setHasUnsavedChanges(false);
    };
  }, [setNavigationBlocked, setHasUnsavedChanges]);

  useEffect(() => {
    if (!currentFile) {
      cleanupPreviewUrl();
      setPreviewUrl("");
      setPreviewKind("");
      setPreviewWatermarked(false);
      setZoomOpen(false);
      setPreviewError("");
    }
  }, [currentFile]);

  useEffect(() => {
    if (!currentFile) return;
    const cacheKey = getFileCacheKey(currentFile);
    if (mediaDimensionMap[cacheKey]) return;

    let cancelled = false;
    void (async () => {
      const dimensions = await detectMediaDimensions(currentFile);
      if (cancelled || !dimensions) return;
      setMediaDimensionMap((prev) => {
        if (prev[cacheKey]) return prev;
        return {
          ...prev,
          [cacheKey]: dimensions,
        };
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [currentFile, mediaDimensionMap]);

  useEffect(() => {
    if (!previewUrlRef.current) return;
    cleanupPreviewUrl();
    setPreviewUrl("");
    setPreviewKind("");
    setPreviewWatermarked(false);
    setPreviewError("");
    resetPreviewProgress();
    setOpenColorFieldKey(null);
    setColorInputDraftMap({});
    setSizeLockMap({});
  }, [selectedTemplateId]);

  useEffect(() => {
    void disposeEvaluationSession();
  }, [runtimeMode]);

  useEffect(() => {
    if (!previewLoading) return;
    if (previewSignatureRef.current === previewSignature) return;

    previewRequestIdRef.current += 1;
    void cancelActivePreview();
    setPreviewLoading(false);
    previewActiveFileRef.current = "";
  }, [previewSignature, previewLoading]);

  useEffect(() => {
    if (!selectedTemplate) return;

    const requestId = ++evaluateRequestIdRef.current;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const evaluated = await evaluateParamsUsingRuntime(params);
          if (requestId !== evaluateRequestIdRef.current) return;
          if (!evaluated.ok) {
            setError(evaluated.error ?? "模板参数评估失败");
            return;
          }
          setEvaluatedFields(evaluated.configFields);
          setNormalizedParams(evaluated.normalizedConfig);
        } catch (evaluateError) {
          if (requestId !== evaluateRequestIdRef.current) return;
          setError(evaluateError instanceof Error ? evaluateError.message : "模板参数评估失败");
        }
      })();
    }, 120);

    return () => {
      window.clearTimeout(timer);
    };
    // evaluateParamsUsingRuntime captures runtime session/context internals; this effect intentionally keys off params/template/mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, selectedTemplate, runtimeMode]);

  useEffect(() => {
    if (!canPreview || !selectedTemplate || !currentFile) return;
    if (state !== "editing" || loadingSchema || isPointerAdjusting) return;

    const timer = window.setTimeout(() => {
      void onPreview();
    }, 900);

    return () => {
      window.clearTimeout(timer);
    };
    // onPreview depends on many mutable states; this effect intentionally tracks core gating inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    params,
    canPreview,
    selectedTemplate,
    currentFile,
    state,
    loadingSchema,
    isMainThreadDebugMode,
    isPointerAdjusting,
  ]);

  async function onDrop(input: FileList | null) {
    if (!input) return;
    const next = Array.from(input).filter((file) => {
      if (file.type) return acceptTypes.includes(file.type);
      return /(jpe?g|png|webp|avif|mp4|mov|mkv)$/i.test(file.name);
    });

    let merged: File[] = [];
    setFiles((prev) => {
      merged = [...prev];
      for (const file of next) {
        const exists = merged.some(
          (item) =>
            item.name === file.name &&
            item.size === file.size &&
            item.lastModified === file.lastModified,
        );
        if (!exists) merged.push(file);
      }
      if (prev.length === 0 && merged.length > 0) {
        setActiveIndex(0);
      }
      return merged;
    });

    const uncachedVideoFiles = merged.filter((file) => {
      if (!file.type.startsWith("video/")) return false;
      return fileCodecSupportMap[getFileCacheKey(file)] === undefined;
    });

    if (uncachedVideoFiles.length > 0) {
      const entries = await Promise.all(
        uncachedVideoFiles.map(async (file) => {
          const key = getFileCacheKey(file);
          const isSupported = await detectFileCodecSupport(file);
          return [key, isSupported] as const;
        }),
      );

      setFileCodecSupportMap((prev) => {
        const nextMap = { ...prev };
        for (const [key, isSupported] of entries) {
          nextMap[key] = isSupported;
        }
        return nextMap;
      });
    }

    const uncachedDimensionFiles = merged.filter(
      (file) => mediaDimensionMap[getFileCacheKey(file)] === undefined,
    );
    if (uncachedDimensionFiles.length > 0) {
      const entries = await Promise.all(
        uncachedDimensionFiles.map(async (file) => {
          const key = getFileCacheKey(file);
          const dimensions = await detectMediaDimensions(file);
          return [key, dimensions] as const;
        }),
      );

      setMediaDimensionMap((prev) => {
        const nextMap = { ...prev };
        for (const [key, dimensions] of entries) {
          if (dimensions) {
            nextMap[key] = dimensions;
          }
        }
        return nextMap;
      });
    }

    setAssets([]);
    setFailedFiles([]);
    setError(next.length === 0 ? "未检测到支持的图片或视频格式。" : "");

    if (next.length > 0 && activeConfigTarget !== "global") {
      switchToConfigTarget("global");
    }
  }

  async function onUploadTemplate(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const importedFiles = await importTemplateZip(file);
      const dynamicTemplate: WatermarkTemplate = {
        id: `custom-${Date.now()}`,
        name: `自定义模板 · ${file.name}`,
        mediaType: "both",
        fields: [],
      };
      setTemplateWorkspaces((prev) => ({ ...prev, [dynamicTemplate.id]: importedFiles }));
      setTemplates((prev) => [dynamicTemplate, ...prev]);
      setSelectedTemplateId(dynamicTemplate.id);
      await initializeTemplateEvaluation(dynamicTemplate, importedFiles);
    } catch (templateError) {
      setError(templateError instanceof Error ? templateError.message : "模板读取失败");
    }
  }

  async function onGenerate() {
    if (invalidFileValidation.length > 0) {
      const names = invalidFileValidation.map((item) => item.file.name);
      const message =
        names.length <= 3
          ? `还有未完成设置的文件：${names.join("、")}`
          : `还有 ${names.length} 个文件未完成设置，无法开始生成`;
      setGenerationWarning(message);
      setGenerationWarningOpen(true);
      return;
    }
    if (!canGenerate) return;

    await cancelActivePreview();
    setPreviewLoading(false);
    previewActiveFileRef.current = "";
    resetPreviewProgress();

    await ensureNotificationPermissionBeforeGeneration();

    setState("processing");
    setProgress(0);
    setProgressMessage("正在初始化生成任务");
    setFailedFiles([]);

    try {
      const generatedAssets: GeneratedAsset[] = [];
      const failedItems: Array<{ name: string; reason: string }> = [];

      const setFileProgress = (
        fileIndex: number,
        fileProgressPercent: number,
        fileName: string,
      ) => {
        const normalized = Math.max(0, Math.min(100, Math.round(fileProgressPercent)));
        const overall = Math.max(
          0,
          Math.min(
            100,
            Math.round(((fileIndex + normalized / 100) / Math.max(1, files.length)) * 100),
          ),
        );
        if (!generateProgressThrottlerRef.current) {
          generateProgressThrottlerRef.current = throttleProgressUpdates(() => {
            const latest = generateLatestProgressRef.current;
            if (!latest) return;
            setProgress(latest.overall);
            setProgressMessage(
              `总进度 ${latest.overall}% | 处理中: ${latest.fileName} (${latest.normalized}%)`,
            );
          });
        }
        generateLatestProgressRef.current = { overall, normalized, fileName };
        generateProgressThrottlerRef.current.push(0);
      };

      const tasks: Array<{
        file: File;
        fileIndex: number;
        template: WatermarkTemplate;
        snapshot: TemplateConfigSnapshot;
      }> = [];

      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        const file = files[fileIndex];
        const fileKey = getFileCacheKey(file);
        const fileSnapshot = effectiveFileOverrides[fileKey] ?? effectiveGlobalSnapshot;
        const fileTemplate = templates.find((item) => item.id === fileSnapshot.selectedTemplateId);
        if (!fileTemplate) {
          failedItems.push({ name: file.name, reason: "未选择模板" });
          setFileProgress(fileIndex, 100, file.name);
          continue;
        }
        tasks.push({
          file,
          fileIndex,
          template: fileTemplate,
          snapshot: fileSnapshot,
        });
      }

      const poolByTemplate = new Map<string, GenerationSessionPool>();

      const disposePools = async () => {
        await Promise.allSettled(Array.from(poolByTemplate.values()).map((pool) => pool.dispose()));
        poolByTemplate.clear();
      };

      const results = await mapConcurrency(tasks, settings.maxConcurrency, async (task) => {
        const { file, fileIndex, template, snapshot } = task;
        try {
          const workspaceFiles = await resolveWorkspaceFiles(template);

          let normalizedConfig: Record<string, unknown> = snapshot.params;
          if (!workspaceFiles) {
            normalizedConfig = snapshot.params;
          } else {
            const session = await ensureEvaluationSession(template, workspaceFiles);
            const evaluated = await session.evaluate(snapshot.params);
            if (!evaluated.ok) {
              throw new Error(evaluated.error ?? "模板参数评估失败");
            }
            normalizedConfig = evaluated.normalizedConfig;
          }

          if (!workspaceFiles) {
            const simulated = await simulateGenerate(
              {
                files: [file],
                template,
                params: toEditableParams(normalizedConfig),
                templateWorkspaceFiles: undefined,
              },
              (status) => {
                setFileProgress(fileIndex, status.percentage, file.name);
              },
            );

            const generated = simulated[0];
            if (!generated) {
              throw new Error("生成结果为空");
            }
            setFileProgress(fileIndex, 100, file.name);
            return generated;
          }

          let pool = poolByTemplate.get(template.id);
          if (!pool) {
            pool = new GenerationSessionPool({
              mode: runtimeMode,
              files: workspaceFiles,
              entry: "index.ts",
              logger: {
                info: () => undefined,
                error: (...args: unknown[]) =>
                  console.error("[template-runtime][generate]", ...args),
                progress: (percent: number) => {
                  setFileProgress(fileIndex, percent, file.name);
                },
              },
              maxConcurrency: settings.maxConcurrency,
            });
            poolByTemplate.set(template.id, pool);
          }

          const runtimeResult = await pool.run({
            config: normalizedConfig,
            mediaFile: file,
          });
          if (!runtimeResult.ok) {
            throw new Error(runtimeResult.error ?? `文件 ${file.name} 生成失败`);
          }

          const blob =
            runtimeResult.value instanceof Blob
              ? runtimeResult.value
              : new Blob([], { type: file.type || "image/png" });
          setFileProgress(fileIndex, 100, file.name);
          return {
            name: buildAssetName(file, blob, fileIndex),
            blob,
          };
        } catch (fileError) {
          const reason = fileError instanceof Error ? fileError.message : "未知错误";
          failedItems.push({ name: file.name, reason });
          console.error("[start-workflow][generate] file failed", {
            file: file.name,
            error: fileError,
          });
          setFileProgress(fileIndex, 100, file.name);
          return null;
        }
      });

      await disposePools();

      for (const result of results) {
        if (result) {
          generatedAssets.push(result);
        }
      }

      setAssets(generatedAssets);
      setFailedFiles(failedItems.map((item) => `${item.name}（${item.reason}）`));
      setState("finished");
      notifyGenerationFinished(generatedAssets.length);
    } catch (generateError) {
      console.error("[start-workflow][generate] failed", { error: generateError });
      setError(generateError instanceof Error ? generateError.message : "生成失败");
      setState("editing");
      setProgressMessage("生成失败");
    }
  }

  function backToEditing() {
    void cancelActivePreview();
    void disposeEvaluationSession();
    cleanupPreviewUrl();
    setFiles([]);
    setActiveIndex(0);
    setSelectedTemplateId("");
    setParams({});
    setNormalizedParams({});
    setEvaluatedFields([]);
    setAssets([]);
    setFailedFiles([]);
    setPreviewUrl("");
    setPreviewKind("");
    setPreviewWatermarked(false);
    setPreviewError("");
    setFileCodecSupportMap({});
    setMediaDimensionMap({});
    setActiveConfigTarget("global");
    setGlobalTemplateConfig(createEmptyTemplateConfigSnapshot());
    setFileTemplateOverrides({});
    setOpenColorFieldKey(null);
    setColorInputDraftMap({});
    setSizeLockMap({});
    setZoomOpen(false);
    setError("");
    setState("editing");
    setProgress(0);
    setProgressMessage("等待开始");
  }

  function downloadBlob(name: string, blob: Blob) {
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
  }

  async function downloadZip() {
    const zipBlob = await exportAsZip(assets);
    downloadBlob("watermark-output.zip", zipBlob);
  }

  function downloadMultiple() {
    for (const asset of assets) {
      downloadBlob(asset.name, asset.blob);
    }
  }

  async function onTemplateChange(templateId: string) {
    setSelectedTemplateId(templateId);
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;

    const workspaceFiles = await resolveWorkspaceFiles(template);

    try {
      setLoadingSchema(true);
      await initializeTemplateEvaluation(template, workspaceFiles);
    } catch (schemaError) {
      setError(schemaError instanceof Error ? schemaError.message : "模板参数解析失败");
    } finally {
      setLoadingSchema(false);
    }
  }

  function renderField(field: ConfigFieldDescriptor) {
    if (field.kind === "boolean") {
      return (
        <Stack key={field.key} spacing={0.4}>
          <FormControlLabel
            control={
              <Switch
                checked={Boolean(getFieldValue(field.key))}
                onChange={(event) =>
                  setParams((prev) => ({
                    ...prev,
                    [field.key]: event.target.checked,
                  }))
                }
              />
            }
            label={field.name}
          />
          {field.description ? (
            <Typography variant="caption" color="text.secondary">
              {field.description}
            </Typography>
          ) : null}
        </Stack>
      );
    }

    if (field.kind === "enum" || field.kind === "select") {
      return (
        <TextField
          key={field.key}
          select
          label={field.name}
          required={field.required}
          placeholder={field.description}
          helperText={field.description}
          value={String(getFieldValue(field.key) ?? "")}
          onChange={(event) =>
            setParams((prev) => ({
              ...prev,
              [field.key]: event.target.value,
            }))
          }
        >
          {(field.options ?? []).map((option) => (
            <MenuItem key={String(option.value)} value={String(option.value)}>
              {option.label}
            </MenuItem>
          ))}
        </TextField>
      );
    }

    if (field.kind === "image") {
      return (
        <Stack key={field.key} spacing={0.8}>
          <Box
            role="button"
            tabIndex={0}
            onClick={() => imageInputRefs.current[field.key]?.click()}
            onDrop={(event) => {
              event.preventDefault();
              void onImageFieldDrop(field.key, event.dataTransfer.files);
            }}
            onDragOver={(event) => event.preventDefault()}
            sx={{
              border: "2px dashed rgba(61, 86, 164, .35)",
              borderRadius: 1.25,
              p: 2,
              textAlign: "center",
              cursor: "pointer",
              background: "linear-gradient(140deg, rgba(255,255,255,.78), rgba(222,235,255,.64))",
            }}
          >
            <CloudUploadRoundedIcon sx={{ fontSize: 30 }} />
            <Typography mt={0.5} fontWeight={700}>
              {field.name}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              将图片拖放到这里，或点击选择图片
            </Typography>
            {typeof getFieldValue(field.key) === "string" && getFieldValue(field.key) ? (
              <Typography variant="caption" color="text.secondary" display="block" mt={0.6}>
                已上传图片
              </Typography>
            ) : null}
            <input
              ref={(node) => {
                imageInputRefs.current[field.key] = node;
              }}
              hidden
              accept="image/*"
              type="file"
              onChange={(event) => {
                void onImageFieldDrop(field.key, event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
          </Box>
          {field.description ? (
            <Typography variant="caption" color="text.secondary">
              {field.description}
            </Typography>
          ) : null}
        </Stack>
      );
    }

    if (field.kind === "rgba") {
      const rgba = readRgbaValue(getFieldValue(field.key));
      const hexaColor = toHexAlphaColor(rgba);
      const inputValue = colorInputDraftMap[field.key] ?? toCssRgbaColor(rgba);
      const pickerOpen = openColorFieldKey === field.key;

      return (
        <Stack key={field.key} spacing={0.9}>
          <Typography variant="subtitle2" fontWeight={700}>
            {field.name}
          </Typography>
          <Button
            size="large"
            variant={pickerOpen ? "contained" : "outlined"}
            onClick={() => setOpenColorFieldKey((prev) => (prev === field.key ? null : field.key))}
            sx={{
              width: "100%",
              minHeight: 52,
              maxWidth: 5,
              justifyContent: "center",
              textTransform: "none",
              p: 0.8,
            }}
          >
            <Box
              sx={{
                width: "100%",
                height: 30,
                borderRadius: 1,
                border: "1px solid rgba(0,0,0,.2)",
                backgroundColor: `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${rgba.a})`,
              }}
            />
          </Button>
          {field.description ? (
            <Typography variant="caption" color="text.secondary">
              {field.description}
            </Typography>
          ) : null}
          {pickerOpen ? (
            <Box
              sx={{
                border: "1px solid rgba(61, 86, 164, .25)",
                borderRadius: 1.25,
                p: 1.2,
                bgcolor: "rgba(255,255,255,.72)",
              }}
            >
              <HexAlphaColorPicker
                color={hexaColor}
                onChange={(nextColor: string) => {
                  const parsed = parseHexAlphaColor(nextColor);
                  if (!parsed) return;
                  setParams((prev) => ({
                    ...prev,
                    [field.key]: parsed,
                  }));
                  setColorInputDraftMap((prev) => ({
                    ...prev,
                    [field.key]: toCssRgbaColor(parsed),
                  }));
                }}
                style={{ width: "100%" }}
              />
              <Box mt={1}>
                <TextField
                  label="RGBA"
                  value={inputValue}
                  onFocus={() => {
                    setColorInputDraftMap((prev) => ({
                      ...prev,
                      [field.key]: toCssRgbaColor(rgba),
                    }));
                  }}
                  onChange={(event) => {
                    const nextInput = event.target.value.trim();
                    setColorInputDraftMap((prev) => ({
                      ...prev,
                      [field.key]: nextInput,
                    }));

                    const parsed = parseCssRgbaColor(nextInput);
                    if (!parsed) return;

                    setParams((prev) => ({
                      ...prev,
                      [field.key]: parsed,
                    }));
                  }}
                  onBlur={() => {
                    const normalized = toCssRgbaColor(readRgbaValue(getFieldValue(field.key)));
                    setColorInputDraftMap((prev) => ({
                      ...prev,
                      [field.key]: normalized,
                    }));
                  }}
                  helperText="格式: rgba(r,g,b,a)"
                  inputProps={{
                    autoComplete: "off",
                    spellCheck: false,
                    style: {
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                      letterSpacing: 0.4,
                    },
                  }}
                  fullWidth
                />
              </Box>
            </Box>
          ) : null}
        </Stack>
      );
    }

    if (field.kind === "rgb") {
      const rgb = readRgbValue(getFieldValue(field.key));
      const colorValue = toHexColor(rgb.r, rgb.g, rgb.b);
      return (
        <Stack key={field.key} spacing={0.8}>
          <Typography variant="subtitle2" fontWeight={700}>
            {field.name}
          </Typography>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.1}>
            <TextField
              type="color"
              value={colorValue}
              onChange={(event) => {
                const next = parseHexToRgb(event.target.value);
                setParams((prev) => ({
                  ...prev,
                  [field.key]: next,
                }));
              }}
              sx={{ width: { xs: "100%", sm: 86 }, minWidth: 86 }}
            />
            <Stack direction="row" spacing={1} width="100%">
              <TextField
                label="R"
                type="number"
                value={rgb.r}
                inputProps={{ min: 0, max: 255 }}
                onChange={(event) => {
                  setParams((prev) => ({
                    ...prev,
                    [field.key]: { ...rgb, r: clampByte(event.target.value, rgb.r) },
                  }));
                }}
              />
              <TextField
                label="G"
                type="number"
                value={rgb.g}
                inputProps={{ min: 0, max: 255 }}
                onChange={(event) => {
                  setParams((prev) => ({
                    ...prev,
                    [field.key]: { ...rgb, g: clampByte(event.target.value, rgb.g) },
                  }));
                }}
              />
              <TextField
                label="B"
                type="number"
                value={rgb.b}
                inputProps={{ min: 0, max: 255 }}
                onChange={(event) => {
                  setParams((prev) => ({
                    ...prev,
                    [field.key]: { ...rgb, b: clampByte(event.target.value, rgb.b) },
                  }));
                }}
              />
            </Stack>
          </Stack>
          {field.description ? (
            <Typography variant="caption" color="text.secondary">
              {field.description}
            </Typography>
          ) : null}
        </Stack>
      );
    }

    if (field.kind === "size") {
      const sizeValue = readSizeValue(getFieldValue(field.key));

      if (isGlobalSettingsView) {
        return (
          <Stack key={field.key} spacing={0.8}>
            <Typography variant="subtitle2" fontWeight={700}>
              {field.name}
            </Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
              <TextField
                label="宽度"
                type="number"
                value={sizeValue.width}
                onChange={(event) =>
                  updateSizeField(
                    field.key,
                    toFiniteNumber(event.target.value, sizeValue.width),
                    sizeValue.height,
                  )
                }
              />
              <TextField
                label="高度"
                type="number"
                value={sizeValue.height}
                onChange={(event) =>
                  updateSizeField(
                    field.key,
                    sizeValue.width,
                    toFiniteNumber(event.target.value, sizeValue.height),
                  )
                }
              />
            </Stack>
            {field.description ? (
              <Typography variant="caption" color="text.secondary">
                {field.description}
              </Typography>
            ) : null}
          </Stack>
        );
      }

      const { width: mediaWidth, height: mediaHeight } = getResolutionBase();
      const ratioLocked = Boolean(sizeLockMap[field.key]);
      const ratio = sizeValue.height > 0 ? sizeValue.width / Math.max(1, sizeValue.height) : 1;
      const panelWidth = 420;
      const panelHeight = Math.max(160, Math.min(240, (panelWidth * mediaHeight) / mediaWidth));
      const actualWidth = Math.max(0, Math.min(mediaWidth, sizeValue.width));
      const actualHeight = Math.max(0, Math.min(mediaHeight, sizeValue.height));
      const ghostWidth = Math.max(1, Math.round(mediaWidth * 0.25));
      const ghostHeight = Math.max(1, Math.round(mediaHeight * 0.2));
      const effectiveWidth = actualWidth > 0 ? actualWidth : ghostWidth;
      const effectiveHeight = actualHeight > 0 ? actualHeight : ghostHeight;
      const widthPercent = Math.max(0.5, (effectiveWidth / Math.max(1, mediaWidth)) * 100);
      const heightPercent = Math.max(0.5, (effectiveHeight / Math.max(1, mediaHeight)) * 100);

      const lockLabel = ratioLocked
        ? `比例 ${toSimplestRatio(effectiveWidth, effectiveHeight)}`
        : sizeValue.width <= 0 && sizeValue.height <= 0
          ? "Auto"
          : `${Math.round(actualWidth)} x ${Math.round(actualHeight)}`;

      const startResize = (
        event: React.PointerEvent<HTMLDivElement>,
        direction: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw",
      ) => {
        event.stopPropagation();
        setIsPointerAdjusting(true);
        const target = event.currentTarget;
        target.setPointerCapture(event.pointerId);

        const startX = event.clientX;
        const startY = event.clientY;
        const startW = effectiveWidth;
        const startH = effectiveHeight;
        const baseRatio = startH > 0 ? startW / startH : 1;
        const panelRect = target.parentElement?.getBoundingClientRect();

        const resizeWithDelta = (deltaX: number, deltaY: number) => {
          let nextWidth = startW;
          let nextHeight = startH;

          const deltaWidth = deltaX * 2;
          const deltaHeight = deltaY * 2;

          if (direction.includes("e")) nextWidth = startW + deltaWidth;
          if (direction.includes("w")) nextWidth = startW - deltaWidth;
          if (direction.includes("s")) nextHeight = startH + deltaHeight;
          if (direction.includes("n")) nextHeight = startH - deltaHeight;

          if (ratioLocked) {
            if (
              (direction === "e" || direction === "w") &&
              !direction.includes("n") &&
              !direction.includes("s")
            ) {
              nextHeight = nextWidth / Math.max(0.0001, baseRatio);
            } else if (
              (direction === "n" || direction === "s") &&
              !direction.includes("e") &&
              !direction.includes("w")
            ) {
              nextWidth = nextHeight * baseRatio;
            } else {
              if (Math.abs(deltaX) >= Math.abs(deltaY)) {
                nextHeight = nextWidth / Math.max(0.0001, baseRatio);
              } else {
                nextWidth = nextHeight * baseRatio;
              }
            }
          }

          nextWidth = Math.max(1, Math.min(mediaWidth, nextWidth));
          nextHeight = Math.max(1, Math.min(mediaHeight, nextHeight));

          if (ratioLocked) {
            if (nextWidth / Math.max(nextHeight, 0.0001) > baseRatio) {
              nextWidth = nextHeight * baseRatio;
            } else {
              nextHeight = nextWidth / Math.max(0.0001, baseRatio);
            }

            if (nextWidth > mediaWidth) {
              nextWidth = mediaWidth;
              nextHeight = nextWidth / Math.max(0.0001, baseRatio);
            }
            if (nextHeight > mediaHeight) {
              nextHeight = mediaHeight;
              nextWidth = nextHeight * baseRatio;
            }
          }

          updateSizeField(field.key, nextWidth, nextHeight);
        };

        const onPointerMove = (moveEvent: PointerEvent) => {
          const scaleX = mediaWidth / Math.max(1, panelRect?.width ?? panelWidth);
          const scaleY = mediaHeight / Math.max(1, panelRect?.height ?? panelHeight);
          const deltaX = (moveEvent.clientX - startX) * scaleX;
          const deltaY = (moveEvent.clientY - startY) * scaleY;
          resizeWithDelta(deltaX, deltaY);
        };

        const onPointerUp = () => {
          target.releasePointerCapture(event.pointerId);
          target.removeEventListener("pointermove", onPointerMove);
          target.removeEventListener("pointerup", onPointerUp);
          target.removeEventListener("pointercancel", onPointerUp);
          setIsPointerAdjusting(false);
        };

        target.addEventListener("pointermove", onPointerMove);
        target.addEventListener("pointerup", onPointerUp);
        target.addEventListener("pointercancel", onPointerUp);
      };

      const handles: Array<{
        key: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
        sx: Record<string, unknown>;
        cursor: string;
      }> = [
        {
          key: "n",
          cursor: "ns-resize",
          sx: { top: -6, left: "50%", transform: "translateX(-50%)" },
        },
        {
          key: "s",
          cursor: "ns-resize",
          sx: { bottom: -6, left: "50%", transform: "translateX(-50%)" },
        },
        {
          key: "e",
          cursor: "ew-resize",
          sx: { right: -6, top: "50%", transform: "translateY(-50%)" },
        },
        {
          key: "w",
          cursor: "ew-resize",
          sx: { left: -6, top: "50%", transform: "translateY(-50%)" },
        },
        { key: "ne", cursor: "nesw-resize", sx: { right: -6, top: -6 } },
        { key: "nw", cursor: "nwse-resize", sx: { left: -6, top: -6 } },
        { key: "se", cursor: "nwse-resize", sx: { right: -6, bottom: -6 } },
        { key: "sw", cursor: "nesw-resize", sx: { left: -6, bottom: -6 } },
      ];

      return (
        <Stack key={field.key} spacing={0.8}>
          <Typography variant="subtitle2" fontWeight={700}>
            {field.name}
          </Typography>
          <Box
            sx={{
              position: "relative",
              alignSelf: "center",
              width: "100%",
              maxWidth: panelWidth,
              height: panelHeight,
              borderRadius: 1,
              border: "1px dashed rgba(61, 86, 164, .35)",
              background: "linear-gradient(180deg, rgba(255,255,255,.58), rgba(237,243,255,.48))",
              overflow: "hidden",
              touchAction: "none",
            }}
          >
            <Box
              sx={{
                position: "absolute",
                left: "50%",
                top: "50%",
                width: `${widthPercent}%`,
                height: `${heightPercent}%`,
                borderRadius: 0.8,
                border: "2px solid rgba(85, 132, 255, .88)",
                bgcolor: "rgba(98, 136, 227, .16)",
                display: "grid",
                placeItems: "center",
                transform: "translate(-50%, -50%)",
              }}
            >
              <Typography variant="caption" color="text.secondary" fontWeight={700}>
                {lockLabel}
              </Typography>
              {handles.map((handle) => (
                <Box
                  key={handle.key}
                  onPointerDown={(event) => startResize(event, handle.key)}
                  sx={{
                    position: "absolute",
                    width: 12,
                    height: 12,
                    borderRadius: 999,
                    backgroundColor: "#5f85ff",
                    border: "2px solid #fff",
                    boxShadow: "0 0 0 1px rgba(70,108,219,.35)",
                    cursor: handle.cursor,
                    ...handle.sx,
                  }}
                />
              ))}
            </Box>
          </Box>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={1}
            alignItems="center"
            style={{
              alignSelf: "center",
            }}
          >
            <TextField
              label="宽度"
              type="number"
              value={sizeValue.width}
              onChange={(event) => {
                const nextWidth = toFiniteNumber(event.target.value, sizeValue.width);
                if (ratioLocked) {
                  updateSizeField(field.key, nextWidth, nextWidth / Math.max(0.0001, ratio));
                  return;
                }
                updateSizeField(field.key, nextWidth, sizeValue.height);
              }}
            />
            <TextField
              label="高度"
              type="number"
              value={sizeValue.height}
              onChange={(event) => {
                const nextHeight = toFiniteNumber(event.target.value, sizeValue.height);
                if (ratioLocked) {
                  updateSizeField(field.key, nextHeight * ratio, nextHeight);
                  return;
                }
                updateSizeField(field.key, sizeValue.width, nextHeight);
              }}
            />
            <Button
              variant={ratioLocked ? "contained" : "outlined"}
              startIcon={ratioLocked ? <LockOutlinedIcon /> : <LockOpenRoundedIcon />}
              onClick={() =>
                setSizeLockMap((prev) => ({
                  ...prev,
                  [field.key]: !ratioLocked,
                }))
              }
            >
              锁定比例
            </Button>
            <Button
              variant="text"
              startIcon={<RestartAltRoundedIcon />}
              onClick={() => updateSizeField(field.key, 0, 0)}
            >
              重置参数
            </Button>
          </Stack>
          {field.description ? (
            <Typography variant="caption" color="text.secondary">
              {field.description}
            </Typography>
          ) : null}
        </Stack>
      );
    }

    if (field.kind === "coord") {
      const coordValue = readCoordValue(getFieldValue(field.key));
      const draggingCoord = coordDraggingMap[field.key];
      const displayCoord = draggingCoord ?? coordValue;

      if (isGlobalSettingsView) {
        return (
          <Stack key={field.key} spacing={0.8}>
            <Typography variant="subtitle2" fontWeight={700}>
              {field.name}
            </Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
              <TextField
                label="x 坐标"
                type="number"
                value={coordValue.x}
                onChange={(event) =>
                  updateCoordField(
                    field.key,
                    toFiniteNumber(event.target.value, coordValue.x),
                    coordValue.y,
                  )
                }
              />
              <TextField
                label="y 坐标"
                type="number"
                value={coordValue.y}
                onChange={(event) =>
                  updateCoordField(
                    field.key,
                    coordValue.x,
                    toFiniteNumber(event.target.value, coordValue.y),
                  )
                }
              />
            </Stack>
            {field.description ? (
              <Typography variant="caption" color="text.secondary">
                {field.description}
              </Typography>
            ) : null}
          </Stack>
        );
      }

      const mediaWidth = activeMediaDimensions?.width ?? 0;
      const mediaHeight = activeMediaDimensions?.height ?? 0;
      const hasResolution = mediaWidth > 0 && mediaHeight > 0;
      const panelWidth = 520;
      const panelHeight = hasResolution
        ? Math.max(140, Math.min(240, (panelWidth * mediaHeight) / mediaWidth))
        : 180;
      const xPercent = hasResolution
        ? Math.max(0, Math.min(100, (displayCoord.x / Math.max(1, mediaWidth)) * 100))
        : 0;
      const yPercent = hasResolution
        ? Math.max(0, Math.min(100, (displayCoord.y / Math.max(1, mediaHeight)) * 100))
        : 0;
      const readPointerCoord = (clientX: number, clientY: number, box: DOMRect) => {
        const ratioX = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
        const ratioY = Math.max(0, Math.min(1, (clientY - box.top) / box.height));
        return {
          x: ratioX * mediaWidth,
          y: ratioY * mediaHeight,
        };
      };

      return (
        <Stack key={field.key} spacing={0.8}>
          <Typography variant="subtitle2" fontWeight={700}>
            {field.name}
          </Typography>
          <Stack direction="row" flexWrap="wrap" gap={1} justifyContent="space-between">
            <Typography variant="caption" color="text.secondary" fontWeight={700}>
              当前坐标 ({Math.round(displayCoord.x)}, {Math.round(displayCoord.y)})
            </Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={700}>
              {hasResolution
                ? `参考分辨率 ${mediaWidth} x ${mediaHeight}`
                : "正在读取媒体分辨率..."}
            </Typography>
          </Stack>
          <Box
            onPointerDown={(event) => {
              if (!hasResolution) return;
              const rect = event.currentTarget.getBoundingClientRect();
              event.currentTarget.setPointerCapture(event.pointerId);
              setIsPointerAdjusting(true);
              setCoordDraggingMap((prev) => ({
                ...prev,
                [field.key]: readPointerCoord(event.clientX, event.clientY, rect),
              }));
            }}
            onPointerMove={(event) => {
              if (!hasResolution) return;
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const rect = event.currentTarget.getBoundingClientRect();
              setCoordDraggingMap((prev) => ({
                ...prev,
                [field.key]: readPointerCoord(event.clientX, event.clientY, rect),
              }));
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              const dragging = coordDraggingMap[field.key];
              if (dragging) {
                updateCoordField(field.key, dragging.x, dragging.y);
              }
              setCoordDraggingMap((prev) => {
                if (!(field.key in prev)) return prev;
                const next = { ...prev };
                delete next[field.key];
                return next;
              });
              setIsPointerAdjusting(false);
            }}
            onPointerCancel={() => {
              setCoordDraggingMap((prev) => {
                if (!(field.key in prev)) return prev;
                const next = { ...prev };
                delete next[field.key];
                return next;
              });
              setIsPointerAdjusting(false);
            }}
            sx={{
              position: "relative",
              width: "100%",
              maxWidth: panelWidth,
              height: panelHeight,
              alignSelf: "center",
              borderRadius: 1.2,
              border: "1px solid rgba(61, 86, 164, .35)",
              overflow: "hidden",
              background:
                "repeating-linear-gradient(0deg, rgba(61,86,164,.12) 0 1px, transparent 1px 20px), repeating-linear-gradient(90deg, rgba(61,86,164,.12) 0 1px, transparent 1px 20px), linear-gradient(180deg, rgba(255,255,255,.62), rgba(231,239,255,.56))",
              touchAction: "none",
              cursor: hasResolution ? "crosshair" : "wait",
              opacity: hasResolution ? 1 : 0.66,
            }}
          >
            <Box
              sx={{
                position: "absolute",
                left: `${xPercent}%`,
                top: 0,
                bottom: 0,
                borderLeft: "1px solid rgba(132, 164, 255, .4)",
                pointerEvents: "none",
              }}
            />
            <Box
              sx={{
                position: "absolute",
                top: `${yPercent}%`,
                left: 0,
                right: 0,
                borderTop: "1px solid rgba(132, 164, 255, .4)",
                pointerEvents: "none",
              }}
            />
            <Box
              sx={{
                position: "absolute",
                left: `${xPercent}%`,
                top: `${yPercent}%`,
                width: 14,
                height: 14,
                borderRadius: "50%",
                backgroundColor: "#6d94ff",
                border: "2px solid #fff",
                boxShadow: "0 0 0 2px rgba(109,148,255,.45)",
                transform: "translate(-50%, -50%)",
                pointerEvents: "none",
              }}
            />
          </Box>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
            <TextField
              label="x 坐标"
              type="number"
              value={coordValue.x}
              disabled={!hasResolution}
              onChange={(event) =>
                updateCoordField(
                  field.key,
                  toFiniteNumber(event.target.value, coordValue.x),
                  coordValue.y,
                )
              }
            />
            <TextField
              label="y 坐标"
              type="number"
              value={coordValue.y}
              disabled={!hasResolution}
              onChange={(event) =>
                updateCoordField(
                  field.key,
                  coordValue.x,
                  toFiniteNumber(event.target.value, coordValue.y),
                )
              }
            />
          </Stack>
          {field.description ? (
            <Typography variant="caption" color="text.secondary">
              {field.description}
            </Typography>
          ) : null}
        </Stack>
      );
    }

    const scalarValue = getFieldValue(field.key);
    return (
      <TextField
        key={field.key}
        label={field.name}
        required={field.required}
        type={field.kind === "number" ? "number" : "text"}
        placeholder={field.description}
        helperText={field.description}
        value={
          typeof scalarValue === "string" || typeof scalarValue === "number" ? scalarValue : ""
        }
        onChange={(event) =>
          setParams((prev) => ({
            ...prev,
            [field.key]:
              field.kind === "number"
                ? event.target.value === ""
                  ? ""
                  : Number(event.target.value)
                : event.target.value,
          }))
        }
      />
    );
  }

  function renderGroup(group: FieldGroupNode, depth: number) {
    const rowFields: ConfigFieldDescriptor[] = [];
    const normalFields: ConfigFieldDescriptor[] = [];

    group.fields.forEach((field) => {
      if (typeof field.gridIndex === "number") {
        rowFields.push(field);
      } else {
        normalFields.push(field);
      }
    });

    rowFields.sort((a, b) => (a.gridIndex ?? 0) - (b.gridIndex ?? 0));

    return (
      <Stack
        key={group.key}
        spacing={1.1}
        sx={
          depth > 0
            ? {
                pl: 1.2,
                borderLeft: "2px solid rgba(61, 86, 164, .2)",
              }
            : undefined
        }
      >
        <Typography
          variant={depth === 0 ? "subtitle2" : "body2"}
          color="text.secondary"
          fontWeight={700}
        >
          {group.label}
        </Typography>
        {rowFields.length > 0 ? (
          <Box
            key={`${group.key}-row`}
            sx={{
              display: "flex",
              flexDirection: "row",
              alignItems: "stretch",
              gap: 1,
              flexWrap: { xs: "wrap", md: "nowrap" },
            }}
          >
            {rowFields.map((field) => (
              <Box
                key={field.key}
                sx={{
                  flex: "1 1 0",
                  minWidth: { xs: "100%", md: 0 },
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                {renderField(field)}
              </Box>
            ))}
          </Box>
        ) : null}
        {normalFields.map((field) => renderField(field))}
        {group.children.map((child) => renderGroup(child, depth + 1))}
      </Stack>
    );
  }

  return (
    <Box>
      <Stack spacing={2.2}>
        <Typography variant="h4" fontWeight={800}>
          开始
        </Typography>
        <Typography color="text.secondary">
          上传图片或视频，选择模板并填写参数，然后开始添加动态水印。
        </Typography>

        {error ? <Alert severity="warning">{error}</Alert> : null}

        {state === "editing" ? (
          <>
            <Card sx={{ borderRadius: 1.25 }}>
              <CardContent>
                <Stack spacing={1.6}>
                  <Typography fontWeight={700}>上传媒体</Typography>
                  <Box
                    role="button"
                    tabIndex={0}
                    onClick={() => inputRef.current?.click()}
                    onDrop={(event) => {
                      event.preventDefault();
                      void onDrop(event.dataTransfer.files);
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    sx={{
                      border: "2px dashed rgba(61, 86, 164, .35)",
                      borderRadius: 1.25,
                      p: { xs: 2.2, sm: 4 },
                      textAlign: "center",
                      cursor: "pointer",
                      background:
                        "linear-gradient(140deg, rgba(255,255,255,.78), rgba(222,235,255,.64))",
                    }}
                  >
                    <CloudUploadRoundedIcon sx={{ fontSize: 38 }} />
                    <Typography mt={1} fontWeight={700}>
                      将文件拖放到这里
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      或者点击打开文件选择 (支持 jpeg/png/webp/avif 与 mp4/mov/mkv)
                    </Typography>
                    <input
                      ref={inputRef}
                      hidden
                      multiple
                      accept={acceptTypes}
                      type="file"
                      onChange={(event) => {
                        void onDrop(event.target.files);
                        event.currentTarget.value = "";
                      }}
                    />
                  </Box>

                  {files.length > 0 ? (
                    <Stack direction="row" flexWrap="wrap" useFlexGap gap={1}>
                      <Chip
                        label="全局设置"
                        size="small"
                        color={activeConfigTarget === "global" ? "primary" : "default"}
                        onClick={() => switchToConfigTarget("global")}
                      />
                      {files.map((file, idx) => {
                        const fileKey = getFileCacheKey(file);
                        const hasOverride = Boolean(fileTemplateOverrides[fileKey]);
                        const invalidReason = invalidFileReasonByKey[fileKey];
                        return (
                          <Chip
                            key={file.name + idx}
                            label={file.name}
                            size="small"
                            color={
                              idx === activeIndex && activeConfigTarget === fileKey
                                ? "primary"
                                : "default"
                            }
                            onClick={() => {
                              setActiveIndex(idx);
                              switchToConfigTarget(fileKey);
                            }}
                            onDelete={() => removeFile(idx)}
                            deleteIcon={<CloseRoundedIcon />}
                            sx={
                              invalidReason
                                ? {
                                    border: "1px solid #ef4444",
                                    boxShadow: "0 0 0 1px rgba(239,68,68,.35) inset",
                                  }
                                : hasOverride
                                  ? {
                                      border: "1px solid #f6c343",
                                      boxShadow: "0 0 0 1px rgba(246,195,67,.35) inset",
                                    }
                                  : undefined
                            }
                          />
                        );
                      })}
                    </Stack>
                  ) : null}
                </Stack>
              </CardContent>
            </Card>

            {files.length > 0
              ? files.map((file) => {
                  const fileKey = getFileCacheKey(file);
                  const supported = fileCodecSupportMap[fileKey];
                  if (!file.type.startsWith("video/") || supported !== false) return null;
                  return (
                    <Alert key={fileKey} severity="warning">
                      <Typography fontWeight={800}>{file.name}</Typography>
                      <Typography variant="body2" mt={0.4}>
                        检测到不支持的视频编码格式。可能无法处理此视频。
                      </Typography>
                    </Alert>
                  );
                })
              : null}

            {files.length > 0 && showUnsupportedWebCodecsWarning ? (
              <Alert severity="warning">
                <Typography fontWeight={800}>您的浏览器不支持硬件编码。</Typography>
                <Typography variant="body2" mt={0.4}>
                  编码视频可能出现速度慢及设备发烫、耗电量高的情况。如果您接受，请继续——否则请切换到现代桌面设备或现代Android设备。
                </Typography>
              </Alert>
            ) : null}

            {files.length > 0 ? (
              <Card sx={{ borderRadius: 1.25 }}>
                <CardContent>
                  <Stack spacing={1.6}>
                    <Stack
                      direction="row"
                      alignItems="center"
                      justifyContent="space-between"
                      spacing={1}
                    >
                      <Typography fontWeight={700}>模板</Typography>
                      {activeConfigTarget !== "global" ? (
                        <Button
                          size="small"
                          variant="text"
                          onClick={restoreActiveFileToGlobalConfig}
                          disabled={!hasActiveOverride}
                        >
                          恢复全局设置
                        </Button>
                      ) : null}
                    </Stack>
                    <TextField
                      select
                      value={selectedTemplateId}
                      onChange={(event) => {
                        void onTemplateChange(event.target.value);
                      }}
                      label="选择模板"
                    >
                      {availableTemplates.map((tpl) => (
                        <MenuItem key={tpl.id} value={tpl.id}>
                          {tpl.name}
                        </MenuItem>
                      ))}
                    </TextField>

                    <Button component="label" variant="outlined">
                      使用自定义模板
                      <input
                        hidden
                        accept=".zip"
                        type="file"
                        onChange={(event) => void onUploadTemplate(event)}
                      />
                    </Button>
                  </Stack>
                </CardContent>
              </Card>
            ) : null}

            {selectedTemplate ? (
              <Card sx={{ borderRadius: 1.25 }}>
                <CardContent>
                  <Stack spacing={1.4}>
                    <Typography fontWeight={700}>参数</Typography>
                    {loadingSchema ? <CircularProgress size={20} /> : null}
                    {groupedVisibleSchemaFields.ungroupedFields.map((field) => renderField(field))}
                    {groupedVisibleSchemaFields.roots.map((group) => renderGroup(group, 0))}
                  </Stack>
                </CardContent>
              </Card>
            ) : null}

            {canPreview ? (
              <Card sx={{ borderRadius: 1.25 }}>
                <CardContent>
                  <Stack spacing={1.2}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography fontWeight={700}>预览</Typography>
                      <Stack direction="row" spacing={1}>
                        <Button
                          size="small"
                          variant="outlined"
                          disabled={previewLoading}
                          onClick={() => void onPreview()}
                        >
                          {previewLoading ? "生成中..." : "生成预览"}
                        </Button>
                        <Button
                          size="small"
                          startIcon={<ArrowBackIosNewRoundedIcon />}
                          onClick={() =>
                            setActiveIndex((v) => (v - 1 + files.length) % files.length)
                          }
                        >
                          左
                        </Button>
                        <Button
                          size="small"
                          endIcon={<ArrowForwardIosRoundedIcon />}
                          onClick={() => setActiveIndex((v) => (v + 1) % files.length)}
                        >
                          右
                        </Button>
                      </Stack>
                    </Stack>
                    <Box
                      sx={{
                        minHeight: 220,
                        borderRadius: 1.25,
                        background:
                          "radial-gradient(circle at 10% 20%, rgba(124,156,255,.45), rgba(28,48,95,.88))",
                        display: "grid",
                        placeItems: "center",
                        color: "white",
                        textAlign: "center",
                        p: 2,
                        overflow: "hidden",
                        position: "relative",
                      }}
                    >
                      {!previewUrl ? (
                        <Box>
                          <Typography fontWeight={700}>
                            {currentFile?.name ?? "未选择文件"}
                          </Typography>
                          <Typography variant="body2">
                            {currentFile
                              ? isImage(currentFile)
                                ? "点击“生成预览”查看图片水印效果"
                                : "点击“生成预览”查看视频前 5 秒预览"
                              : ""}
                          </Typography>
                        </Box>
                      ) : previewKind === "image" ? (
                        <Box sx={{ width: "100%", display: "grid", gap: 1 }}>
                          <Box
                            component="img"
                            src={previewUrl}
                            alt="预览图"
                            onClick={() => setZoomOpen(true)}
                            sx={{
                              width: "100%",
                              maxHeight: 360,
                              objectFit: "contain",
                              borderRadius: 1,
                              cursor: "zoom-in",
                              border: "1px solid rgba(255,255,255,.18)",
                            }}
                          />
                          <Typography variant="caption" color="rgba(255,255,255,.88)">
                            {previewWatermarked
                              ? "确认预览后，请点击右侧保存按钮生成"
                              : "正在生成预览"}
                          </Typography>
                        </Box>
                      ) : (
                        <Box sx={{ width: "100%", position: "relative" }}>
                          <Box
                            component="video"
                            src={previewUrl}
                            muted
                            playsInline
                            autoPlay
                            controls
                            onClick={() => setZoomOpen(true)}
                            onTimeUpdate={(event: React.SyntheticEvent<HTMLVideoElement>) => {
                              const video = event.currentTarget;
                              if (video.currentTime >= 5) {
                                video.currentTime = 0;
                                void video.play();
                              }
                            }}
                            sx={{
                              width: "100%",
                              maxHeight: 360,
                              objectFit: "contain",
                              borderRadius: 1,
                              cursor: "zoom-in",
                              border: "1px solid rgba(255,255,255,.18)",
                              backgroundColor: "black",
                            }}
                          />
                          <Typography variant="caption" color="rgba(255,255,255,.88)">
                            确认预览后，请点击右侧保存按钮生成
                          </Typography>
                        </Box>
                      )}

                      {previewLoading ? (
                        <Box
                          sx={{
                            position: "absolute",
                            inset: 0,
                            bgcolor: "rgba(4,8,20,.35)",
                            display: "grid",
                            placeItems: "center",
                          }}
                        >
                          <Stack alignItems="center" spacing={1.2}>
                            <CircularProgress size={28} sx={{ color: "white" }} />
                            <Typography variant="body2" color="white" fontWeight={700}>
                              {previewProgressMessage ||
                                `正在处理 ${currentFile?.name ?? "当前文件"}...`}
                            </Typography>
                            <LinearProgress
                              variant="determinate"
                              value={previewProgress}
                              sx={{
                                width: 220,
                                maxWidth: "70vw",
                                height: 8,
                                borderRadius: 999,
                                bgcolor: "rgba(255,255,255,.18)",
                              }}
                            />
                            <Typography variant="caption" color="white">
                              预览生成中
                            </Typography>
                          </Stack>
                        </Box>
                      ) : null}
                    </Box>
                    {previewError ? <Alert severity="warning">{previewError}</Alert> : null}
                  </Stack>
                </CardContent>
              </Card>
            ) : null}

            {files.length > 0 ? (
              <Fab
                color="secondary"
                aria-label="开始生成"
                onClick={() => void onGenerate()}
                sx={{ position: "fixed", right: 18, bottom: 152 }}
              >
                <SaveRoundedIcon />
              </Fab>
            ) : null}
          </>
        ) : null}

        {state === "processing" ? (
          <Card sx={{ borderRadius: 1.25 }}>
            <CardContent>
              <Stack spacing={2}>
                <Typography variant="h5" fontWeight={700}>
                  正在生成中
                </Typography>
                <Typography color="text.secondary">
                  请不要关闭此页面。完成之后，你会收到一条通知。
                </Typography>
                <LinearProgress
                  variant="determinate"
                  value={progress}
                  sx={{ height: 10, borderRadius: 5 }}
                />
                <Typography variant="body2" color="text.secondary">
                  {progressMessage}
                </Typography>
              </Stack>
            </CardContent>
          </Card>
        ) : null}

        {state === "finished" ? (
          <Card sx={{ borderRadius: 1.25 }}>
            <CardContent>
              <Stack spacing={1.8}>
                <Typography variant="h5" fontWeight={700}>
                  制作完成
                </Typography>
                <Typography color="text.secondary">
                  你可以选择打包下载或逐个下载输出文件。
                </Typography>
                {failedFiles.length > 0 ? (
                  <Alert severity="warning">
                    <Typography fontWeight={700}>以下文件处理失败：</Typography>
                    <Typography variant="body2" component="div">
                      {failedFiles.join("；")}
                    </Typography>
                  </Alert>
                ) : null}
                <Divider />
                {assets.length > 0 ? (
                  <Stack direction={{ xs: "column", sm: "row" }} spacing={1.2}>
                    <Button
                      startIcon={<DownloadRoundedIcon />}
                      variant="contained"
                      onClick={() => void downloadZip()}
                    >
                      以 Zip 形式下载
                    </Button>
                    <Button
                      startIcon={<DownloadRoundedIcon />}
                      variant="outlined"
                      onClick={downloadMultiple}
                    >
                      以多文件下载
                    </Button>
                  </Stack>
                ) : (
                  <Typography color="text.secondary">没有成功生成可下载的文件。</Typography>
                )}
                <Button
                  variant="text"
                  startIcon={<RestartAltRoundedIcon />}
                  onClick={backToEditing}
                  sx={{ alignSelf: "flex-start", mt: 1 }}
                >
                  返回
                </Button>
              </Stack>
            </CardContent>
          </Card>
        ) : null}

        <Modal open={zoomOpen && Boolean(previewUrl)} onClose={() => setZoomOpen(false)}>
          <Box
            sx={{
              position: "fixed",
              inset: 0,
              bgcolor: "rgba(0,0,0,.82)",
              display: "grid",
              placeItems: "center",
              p: 2,
            }}
          >
            <IconButton
              onClick={() => setZoomOpen(false)}
              sx={{
                position: "fixed",
                top: 14,
                right: 14,
                color: "white",
                bgcolor: "rgba(0,0,0,.35)",
              }}
            >
              <CloseRoundedIcon />
            </IconButton>

            {previewKind === "image" ? (
              <Box
                component="img"
                src={previewUrl}
                alt="放大预览"
                sx={{
                  maxWidth: "96vw",
                  maxHeight: "92vh",
                  objectFit: "contain",
                  borderRadius: 1.2,
                }}
              />
            ) : (
              <Box
                component="video"
                src={previewUrl}
                controls
                autoPlay
                muted
                playsInline
                onTimeUpdate={(event: React.SyntheticEvent<HTMLVideoElement>) => {
                  const video = event.currentTarget;
                  if (video.currentTime >= 5) {
                    video.currentTime = 0;
                    void video.play();
                  }
                }}
                sx={{
                  maxWidth: "96vw",
                  maxHeight: "92vh",
                  objectFit: "contain",
                  borderRadius: 1.2,
                }}
              />
            )}
          </Box>
        </Modal>

        <Snackbar
          open={generationWarningOpen}
          autoHideDuration={5200}
          onClose={(_, reason) => {
            if (reason === "clickaway") {
              return;
            }
            setGenerationWarningOpen(false);
          }}
          anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        >
          <Alert
            severity="warning"
            variant="filled"
            onClose={() => setGenerationWarningOpen(false)}
            sx={{ width: "100%" }}
          >
            {generationWarning}
          </Alert>
        </Snackbar>
      </Stack>

      <Typography
        variant="caption"
        color="text.disabled"
        sx={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 64,
          textAlign: "center",
          pointerEvents: "none",
          zIndex: 2,
        }}
      >
        Made with love by FurryR
      </Typography>
    </Box>
  );
}

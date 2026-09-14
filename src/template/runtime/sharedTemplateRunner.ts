import * as PIXI from "pixi.js";
import { compileTemplateWorkspace, type TemplateWorkspaceFiles } from "./compiler";
import {
  getEnabledSchemaFields,
  getSchemaFields,
  normalizeSchemaConfig,
  schema,
  scheme,
  type SchemaField,
} from "../schema";
import type { FrameCallback, FrameMeta, VideoInput, VideoOutput } from "../../media/interfaces";
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output,
  canEncodeVideo,
} from "mediabunny";
import type { VideoCodec } from "mediabunny";
import { ensureWebCodecsPolyfill } from "./webCodecsPolyfill";

interface PixiTextureLike {
  uid?: number;
  source?: {
    style?: unknown;
  };
}

interface PixiTexturePoolLike {
  _texturePool?: Record<string | number, unknown[]>;
  _poolKeyHash?: Record<number, string | number | undefined>;
  textureStyle?: unknown;
  clear?: (destroyTextures?: boolean) => void;
  returnTexture?: (renderTexture: PixiTextureLike, resetStyle?: boolean) => void;
}

interface PixiRendererDestroyOptionsLike {
  removeView?: boolean;
  releaseGlobalResources?: boolean;
}

interface PixiApplicationLike {
  destroy: (
    rendererDestroyOptions?: boolean | PixiRendererDestroyOptionsLike,
    options?: boolean | Record<string, unknown>,
  ) => void;
}

interface PixiExtensionsLike {
  _addHandlers?: Record<string, unknown>;
  _removeHandlers?: Record<string, unknown>;
  handle?: (
    type: string,
    onAdd: (ext: unknown) => void,
    onRemove: (ext: unknown) => void,
  ) => unknown;
  __templatePatchedHandle?: boolean;
}

let pixiRuntimeLifecycleGuardsApplied = false;
let pixiRuntimeEnvironmentInitialized = false;
let webCodecsGuardsApplied = false;

function toArrayBuffer(input: AllowSharedBufferSource): ArrayBuffer {
  if (ArrayBuffer.isView(input)) {
    const copied = new Uint8Array(input.byteLength);
    copied.set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
    return copied.buffer;
  }

  if (input instanceof ArrayBuffer) {
    return input.slice(0);
  }

  const copied = new Uint8Array(input.byteLength);
  copied.set(new Uint8Array(input));
  return copied.buffer;
}

function cleanH264NALUnit(nalu: Uint8Array, expectedType: number): Uint8Array {
  if (nalu.length === 0) return nalu;

  let start = 0;

  // Defensive normalization: if Annex-B start code leaked into AVCC NALU, strip it.
  if (nalu.length > 4 && nalu[0] === 0 && nalu[1] === 0) {
    if (nalu[2] === 0 && nalu[3] === 1) {
      start = 4;
    } else if (nalu[2] === 1) {
      start = 3;
    }
  }

  while (start < nalu.length - 1) {
    const type = nalu[start] & 0x1f;
    if (type === expectedType && nalu[start] === nalu[start + 1]) {
      start += 1;
    } else {
      break;
    }
  }

  return start === 0 ? nalu : nalu.slice(start);
}

/**
 * Parse and sanitize AVCDecoderConfigurationRecord (AVCC) according to ISO/IEC 14496-15.
 */
function sanitizeAVCCRecord(buffer: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  const rawBuffer = toArrayBuffer(
    ArrayBuffer.isView(buffer)
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : buffer,
  );
  const view = new DataView(rawBuffer);
  const bytes = new Uint8Array(rawBuffer);

  if (bytes.length < 7 || bytes[0] !== 0x01) {
    return rawBuffer.slice(0);
  }

  try {
    let offset = 0;

    const version = view.getUint8(offset++);
    const profile = view.getUint8(offset++);
    const profileCompat = view.getUint8(offset++);
    const level = view.getUint8(offset++);

    const lengthSizeMinusOne = view.getUint8(offset++) | 0xfc;

    const numOfSPSByte = view.getUint8(offset++);
    const numOfSPS = numOfSPSByte & 0x1f;
    const fixedNumOfSPSByte = numOfSPSByte | 0xe0;

    const spsList: Uint8Array[] = [];
    for (let i = 0; i < numOfSPS; i += 1) {
      const spsLen = view.getUint16(offset);
      offset += 2;
      const spsNalu = bytes.subarray(offset, offset + spsLen);
      spsList.push(cleanH264NALUnit(spsNalu, 7));
      offset += spsLen;
    }

    const numOfPPS = view.getUint8(offset++);
    const ppsList: Uint8Array[] = [];
    for (let i = 0; i < numOfPPS; i += 1) {
      const ppsLen = view.getUint16(offset);
      offset += 2;
      const ppsNalu = bytes.subarray(offset, offset + ppsLen);
      ppsList.push(cleanH264NALUnit(ppsNalu, 8));
      offset += ppsLen;
    }

    let newTotalLength = 7;
    for (const sps of spsList) newTotalLength += 2 + sps.length;
    for (const pps of ppsList) newTotalLength += 2 + pps.length;

    const newBuffer = new ArrayBuffer(newTotalLength);
    const newView = new DataView(newBuffer);
    const newBytes = new Uint8Array(newBuffer);

    let writeOffset = 0;
    newView.setUint8(writeOffset++, version);
    newView.setUint8(writeOffset++, profile);
    newView.setUint8(writeOffset++, profileCompat);
    newView.setUint8(writeOffset++, level);
    newView.setUint8(writeOffset++, lengthSizeMinusOne);
    newView.setUint8(writeOffset++, fixedNumOfSPSByte);

    for (const sps of spsList) {
      newView.setUint16(writeOffset, sps.length);
      writeOffset += 2;
      newBytes.set(sps, writeOffset);
      writeOffset += sps.length;
    }

    newView.setUint8(writeOffset++, numOfPPS);

    for (const pps of ppsList) {
      newView.setUint16(writeOffset, pps.length);
      writeOffset += 2;
      newBytes.set(pps, writeOffset);
      writeOffset += pps.length;
    }

    return newBuffer;
  } catch (error) {
    console.warn("[WebCodecs] 无法解析或修复 AVCC 头，退回原始数据", error);
    return rawBuffer.slice(0);
  }
}

function ensureWebCodecsLifecycleGuards() {
  // FIXME: Firefox 149 AVCC bug (Windows)
  if (webCodecsGuardsApplied || typeof globalThis.VideoEncoder === "undefined") {
    return;
  }
  webCodecsGuardsApplied = true;

  const OriginalVideoEncoder = globalThis.VideoEncoder;
  globalThis.VideoEncoder = new Proxy(OriginalVideoEncoder, {
    construct(target, args) {
      const init = args[0] as VideoEncoderInit | undefined;
      if (init && typeof init.output === "function") {
        const originalOutput = init.output as (
          chunk: EncodedVideoChunk,
          metadata?: EncodedVideoChunkMetadata,
        ) => void;
        let checkedDescriptionOnFirstFrame = false;

        init.output = function patchedOutput(
          chunk: EncodedVideoChunk,
          metadata?: EncodedVideoChunkMetadata,
        ) {
          if (!checkedDescriptionOnFirstFrame) {
            checkedDescriptionOnFirstFrame = true;
            const decoderConfig = metadata?.decoderConfig;
            const description = decoderConfig?.description;
            const codec = (decoderConfig?.codec ?? "").toLowerCase();
            const isAvc = codec.startsWith("avc");
            if (description && isAvc && decoderConfig) {
              decoderConfig.description = sanitizeAVCCRecord(toArrayBuffer(description));
            }
          }

          originalOutput(chunk, metadata);
        };
      }

      return Reflect.construct(target, args);
    },
  });
}

function normalizePixiRendererDestroyOptions(
  rendererDestroyOptions: boolean | PixiRendererDestroyOptionsLike = false,
) {
  if (rendererDestroyOptions === true) {
    return {
      removeView: true,
      releaseGlobalResources: false,
    } satisfies PixiRendererDestroyOptionsLike;
  }

  if (!rendererDestroyOptions || typeof rendererDestroyOptions !== "object") {
    return rendererDestroyOptions;
  }

  return {
    ...rendererDestroyOptions,
    releaseGlobalResources: false,
  } satisfies PixiRendererDestroyOptionsLike;
}

function ensurePixiRuntimeLifecycleGuards() {
  if (pixiRuntimeLifecycleGuardsApplied) {
    return;
  }
  pixiRuntimeLifecycleGuardsApplied = true;

  const pixiExtensions = (PIXI as unknown as { extensions?: PixiExtensionsLike }).extensions;
  if (
    pixiExtensions &&
    typeof pixiExtensions.handle === "function" &&
    !pixiExtensions.__templatePatchedHandle
  ) {
    const originalHandle = pixiExtensions.handle;
    pixiExtensions.handle = function patchedHandle(type, onAdd, onRemove) {
      // Safari/WebKit occasionally double-evaluates PIXI init path inside template runtime.
      if (
        (type === "texture-source" || type === "environment") &&
        (this._addHandlers?.[type] || this._removeHandlers?.[type])
      ) {
        return this;
      }

      return originalHandle.call(this, type, onAdd, onRemove);
    };
    pixiExtensions.__templatePatchedHandle = true;
  }

  const texturePool = (PIXI as unknown as { TexturePool?: PixiTexturePoolLike }).TexturePool;
  if (texturePool && typeof texturePool.clear === "function") {
    const originalTexturePoolClear = texturePool.clear.bind(texturePool);

    texturePool.clear = (destroyTextures?: boolean) => {
      originalTexturePoolClear(destroyTextures);
      texturePool._poolKeyHash = Object.create(null) as Record<number, string | number | undefined>;
      texturePool._texturePool = texturePool._texturePool ?? {};
    };
  }

  const applicationPrototype = (
    PIXI as unknown as {
      Application?: {
        prototype?: PixiApplicationLike;
      };
    }
  ).Application?.prototype;

  if (applicationPrototype && typeof applicationPrototype.destroy === "function") {
    const originalApplicationDestroy = applicationPrototype.destroy;

    applicationPrototype.destroy = function patchedDestroy(rendererDestroyOptions, options) {
      return originalApplicationDestroy.call(
        this,
        normalizePixiRendererDestroyOptions(rendererDestroyOptions),
        options,
      );
    };
  }
}

function ensurePixiRuntimeEnvironment() {
  if (pixiRuntimeEnvironmentInitialized) {
    return;
  }
  pixiRuntimeEnvironmentInitialized = true;

  const isWorkerRuntime =
    typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope;

  if (!isWorkerRuntime) {
    return;
  }

  const domAdapter = (
    PIXI as unknown as {
      DOMAdapter?: { set?: (adapter: unknown) => void };
      WebWorkerAdapter?: unknown;
    }
  ).DOMAdapter;
  const webWorkerAdapter = (PIXI as unknown as { WebWorkerAdapter?: unknown }).WebWorkerAdapter;

  if (domAdapter && typeof domAdapter.set === "function" && webWorkerAdapter) {
    domAdapter.set(webWorkerAdapter);
  }
}

export type RuntimeOutputProfile = "default" | "preview-fast";

export interface RuntimeLogger {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  progress?: (percent: number) => void;
}

export type TemplateDefaultExport = (
  config: Record<string, unknown>,
  imageOrVideo: unknown,
  logger: RuntimeLogger,
) => Promise<unknown> | unknown;

export type TemplateConfigCtor = new () => unknown;

export interface EvaluatedConfigFieldDescriptor {
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

type InputFrameSource = OffscreenCanvas;

type AudioPacket = Awaited<ReturnType<EncodedPacketSink["getFirstPacket"]>>;

function createAbortError() {
  const error = new Error("模板执行已取消");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function invokeFrameCallback<TFrame>(
  callback: FrameCallback<TFrame>,
  frame: TFrame,
  meta: FrameMeta,
) {
  if (callback.length >= 2) {
    (callback as (frameValue: TFrame, frameMeta: FrameMeta) => void)(frame, meta);
    return;
  }
  (callback as (frameMeta: FrameMeta) => void)(meta);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function createFrameProgressBridge(progress?: (percent: number) => void) {
  let activeMeta: FrameMeta | null = null;
  let lastReported = 0;

  const report = (percent: number) => {
    if (!progress) return;
    const clampedPercent = clamp(percent, 0, 100);
    const stablePercent = Math.max(lastReported, clampedPercent);
    lastReported = stablePercent;
    progress(stablePercent);
  };

  return {
    enterFrame(meta: FrameMeta) {
      activeMeta = meta;
    },
    leaveFrame() {
      activeMeta = null;
    },
    reportTemplateProgress(percent: number) {
      if (!activeMeta) {
        report(percent);
        return;
      }

      const totalFrames = Math.max(1, Math.round(activeMeta.total || 1));
      const frameIndex = clamp(Math.round(activeMeta.index || 1), 1, totalFrames);
      const framePercent = clamp(percent, 0, 100);
      const overallProgress =
        ((frameIndex - 1) / totalFrames) * 100 + ((100 / totalFrames) * framePercent) / 100;

      report(overallProgress);
    },
  };
}

function createProgressAwareInput(
  input: VideoInput<InputFrameSource>,
  onEnterFrame: (meta: FrameMeta) => void,
  onLeaveFrame: () => void,
): VideoInput<InputFrameSource> {
  return {
    ...input,
    onFrame(callback) {
      input.onFrame((frameOrMeta: InputFrameSource | FrameMeta, maybeMeta?: FrameMeta) => {
        const meta = (maybeMeta ?? frameOrMeta) as FrameMeta;
        onEnterFrame(meta);
        try {
          if (maybeMeta) {
            invokeFrameCallback(callback, frameOrMeta as InputFrameSource, meta);
            return;
          }
          invokeFrameCallback(callback, input.source, meta);
        } finally {
          onLeaveFrame();
        }
      });
    },
  };
}

function roundEven(value: number) {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function getPreviewFastBitrateBounds(width: number, height: number) {
  const area = width * height;
  if (area >= 3840 * 2160) return { min: 2_000_000, max: 8_000_000 };
  if (area >= 2560 * 1440) return { min: 1_500_000, max: 5_000_000 };
  if (area >= 1920 * 1080) return { min: 1_000_000, max: 3_000_000 };
  return { min: 700_000, max: 2_000_000 };
}

function getDefaultBitrateFloor(width: number, height: number) {
  const area = width * height;
  if (area >= 3840 * 2160) return 12_000_000;
  if (area >= 2560 * 1440) return 8_000_000;
  if (area >= 1920 * 1080) return 5_000_000;
  return 2_500_000;
}

function resolveTargetBitrate(options: {
  sourceBitrate: number;
  width: number;
  height: number;
  profile: RuntimeOutputProfile;
}) {
  const normalizedSourceBitrate = Math.max(1, Math.round(options.sourceBitrate));
  if (options.profile === "default") {
    return Math.max(normalizedSourceBitrate, getDefaultBitrateFloor(options.width, options.height));
  }

  const bounds = getPreviewFastBitrateBounds(options.width, options.height);
  const rawTarget = Math.round(normalizedSourceBitrate * 0.55);
  return clamp(rawTarget, bounds.min, bounds.max);
}

function scaleResolutionForProfile(width: number, height: number, profile: RuntimeOutputProfile) {
  if (profile !== "preview-fast") {
    return { width, height };
  }

  const maxEdge = 1280;
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) {
    return { width, height };
  }

  const scale = maxEdge / longEdge;
  return {
    width: roundEven(width * scale),
    height: roundEven(height * scale),
  };
}

function getMimeType(fileType: string) {
  if (fileType === "image/jpeg" || fileType === "image/webp" || fileType === "image/avif") {
    return fileType;
  }
  return "image/png";
}

function createCanvasOutput(
  width: number,
  height: number,
  mimeType: string,
  bitrate: number,
): VideoOutput {
  const source = new OffscreenCanvas(width, height);

  const quality = mimeType === "image/png" ? undefined : 1;

  return {
    source,
    push() {},
    async finish() {
      return quality === undefined
        ? source.convertToBlob({ type: mimeType })
        : source.convertToBlob({ type: mimeType, quality });
    },
    framerate: 30,
    resolution: [width, height],
    bitrate,
    duration: 1000 / 30,
  };
}

const codecProbeCache = new Map<string, VideoCodec>();

async function pickMediabunnyVideoCodec(
  width: number,
  height: number,
  bitrate: number,
): Promise<VideoCodec> {
  const cacheKey = `${width}x${height}`;
  const cachedCodec = codecProbeCache.get(cacheKey);
  if (cachedCodec) {
    return cachedCodec;
  }

  const codecCandidates: VideoCodec[] = ["avc", "vp9", "hevc", "av1", "vp8"];
  for (const codec of codecCandidates) {
    if (await canEncodeVideo(codec, { width, height, bitrate })) {
      codecProbeCache.set(cacheKey, codec);
      return codec;
    }
  }

  throw new Error("当前浏览器没有可用的 Mediabunny 视频编码器");
}

async function createMediabunnyOutput(
  width: number,
  height: number,
  preferredFramerate: number,
  bitrate: number,
  durationMilliseconds: number,
  sourceAudioTrack: Awaited<ReturnType<Input["getPrimaryAudioTrack"]>>,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<{
  output: VideoOutput;
  actualFramerate: number;
  waitForDrain: () => Promise<void>;
  setNextFrameTimestamp: (seconds: number) => void;
}> {
  throwIfAborted(signal);
  const actualFramerate = Math.max(1, Math.min(60, preferredFramerate || 30));
  const codec = await pickMediabunnyVideoCodec(width, height, bitrate);
  const target = new BufferTarget();
  const outputFile = new Output({
    format: new Mp4OutputFormat(),
    target,
  });
  const sourceCanvas = new OffscreenCanvas(width, height);
  let source: CanvasSource | null = null;
  let audioTrackRegistered = false;

  const ensureSource = () => {
    if (source) {
      return source;
    }

    source = new CanvasSource(sourceCanvas, {
      codec,
      bitrate,
      bitrateMode: "constant",
    });
    outputFile.addVideoTrack(source, { frameRate: actualFramerate });
    return source;
  };

  // Register tracks lazily before start(), keeping video track first.
  const ensureTracksRegistered = () => {
    const activeSource = ensureSource();
    if (audioSource && !audioTrackRegistered) {
      outputFile.addAudioTrack(audioSource);
      audioTrackRegistered = true;
    }
    return activeSource;
  };

  const totalDurationSeconds = durationMilliseconds / 1000;
  const canCopyAudio = Boolean(sourceAudioTrack?.codec);
  let audioSource: EncodedAudioPacketSource | null = null;
  let audioDecoderConfig: AudioDecoderConfig | null = null;
  let audioPacketIterator: AsyncGenerator<AudioPacket, void, unknown> | null = null;
  let pendingAudioPacket: AudioPacket | null | undefined;
  let audioTimestampShiftSeconds: number | null = null;
  let audioMetaSent = false;

  if (canCopyAudio && sourceAudioTrack?.codec) {
    try {
      audioSource = new EncodedAudioPacketSource(sourceAudioTrack.codec);
      const audioPacketSink = new EncodedPacketSink(sourceAudioTrack);
      audioDecoderConfig = await sourceAudioTrack.getDecoderConfig();
      audioPacketIterator = audioPacketSink.packets();
    } catch {
      audioSource = null;
      audioDecoderConfig = null;
      audioPacketIterator = null;
      pendingAudioPacket = null;
    }
  }

  let started = false;
  let frameIndex = 0;
  let nextFrameTimestampSeconds: number | null = null;
  let finalizedBlob: Blob | null = null;
  let pendingWork: Promise<void> = Promise.resolve();
  let pipelineError: unknown = null;

  const enqueue = (task: () => Promise<void>) => {
    pendingWork = pendingWork
      .then(async () => {
        throwIfAborted(signal);
        if (pipelineError) {
          throw pipelineError;
        }
        await task();
      })
      .catch((error) => {
        pipelineError = error;
        throw error;
      });
  };

  const enqueueAudioUntil = (untilSeconds: number) => {
    if (!audioSource || !audioPacketIterator) {
      return;
    }

    enqueue(async () => {
      while (true) {
        if (pendingAudioPacket === undefined) {
          const next = await audioPacketIterator.next();
          pendingAudioPacket = next.done ? null : next.value;
        }

        const packet = pendingAudioPacket;
        if (!packet) {
          break;
        }

        if (audioTimestampShiftSeconds === null) {
          audioTimestampShiftSeconds = packet.timestamp < 0 ? -packet.timestamp : 0;
        }

        const normalizedTimestamp = packet.timestamp + audioTimestampShiftSeconds;
        const normalizedPacket =
          audioTimestampShiftSeconds > 0
            ? packet.clone({ timestamp: Math.max(0, normalizedTimestamp) })
            : packet;

        if (
          normalizedPacket.timestamp >= totalDurationSeconds ||
          normalizedPacket.timestamp >= untilSeconds
        ) {
          break;
        }

        if (!audioMetaSent && audioDecoderConfig) {
          await audioSource.add(normalizedPacket, { decoderConfig: audioDecoderConfig });
        } else {
          await audioSource.add(normalizedPacket);
        }

        audioMetaSent = true;
        pendingAudioPacket = undefined;
      }
    });
  };

  return {
    output: {
      source: sourceCanvas,
      push() {
        if (pipelineError) {
          throw pipelineError instanceof Error ? pipelineError : new Error("Mediabunny 写入失败");
        }

        const activeSource = ensureTracksRegistered();

        if (!started) {
          started = true;
          enqueue(() => outputFile.start());
        }

        frameIndex += 1;
        const timestampSeconds =
          nextFrameTimestampSeconds ?? (frameIndex - 1) / Math.max(1, actualFramerate);
        nextFrameTimestampSeconds = null;
        const frameDurationSeconds = 1 / Math.max(1, actualFramerate);
        enqueue(() => activeSource.add(timestampSeconds, frameDurationSeconds));
        enqueueAudioUntil(timestampSeconds + frameDurationSeconds);
      },
      async finish() {
        throwIfAborted(signal);
        if (finalizedBlob) {
          return finalizedBlob;
        }

        if (!started) {
          throw new Error("Video is empty");
        }

        await pendingWork;

        if (pipelineError) {
          throw pipelineError instanceof Error ? pipelineError : new Error("Mediabunny 写入失败");
        }

        enqueueAudioUntil(totalDurationSeconds + 1);
        await pendingWork;

        throwIfAborted(signal);

        source?.close();
        audioSource?.close();
        await outputFile.finalize();

        if (!target.buffer) {
          throw new Error("Mediabunny 写入失败：未生成 MP4 缓冲区");
        }

        finalizedBlob = new Blob([target.buffer], { type: "video/mp4" });
        // finalizedBlob = withBlobDurationMetadata(outputBlob, durationMilliseconds);
        onProgress?.(100);
        return finalizedBlob;
      },
      framerate: actualFramerate,
      resolution: [width, height],
      bitrate,
      duration: Math.max(0, Math.round(durationMilliseconds)),
    },
    actualFramerate,
    waitForDrain: async () => {
      await pendingWork;
      if (pipelineError) {
        throw pipelineError instanceof Error ? pipelineError : new Error("Mediabunny 写入失败");
      }
    },
    setNextFrameTimestamp: (seconds: number) => {
      if (!Number.isFinite(seconds)) {
        nextFrameTimestampSeconds = null;
        return;
      }
      nextFrameTimestampSeconds = Math.max(0, seconds);
    },
  };
}

async function readVideoTrackStats(videoTrack: Awaited<ReturnType<Input["getPrimaryVideoTrack"]>>) {
  if (!videoTrack) {
    return {
      averagePacketRate: 30,
      averageBitrate: 0,
    };
  }

  try {
    const stats = await videoTrack.computePacketStats();
    return {
      averagePacketRate:
        Number.isFinite(stats.averagePacketRate) && stats.averagePacketRate > 0
          ? stats.averagePacketRate
          : 30,
      averageBitrate:
        Number.isFinite(stats.averageBitrate) && stats.averageBitrate > 0
          ? stats.averageBitrate
          : 0,
    };
  } catch {
    try {
      const stats = await videoTrack.computePacketStats(240);
      return {
        averagePacketRate:
          Number.isFinite(stats.averagePacketRate) && stats.averagePacketRate > 0
            ? stats.averagePacketRate
            : 30,
        averageBitrate:
          Number.isFinite(stats.averageBitrate) && stats.averageBitrate > 0
            ? stats.averageBitrate
            : 0,
      };
    } catch {
      return {
        averagePacketRate: 30,
        averageBitrate: 0,
      };
    }
  }
}

async function createMediaInput(
  file?: File,
  maxDurationMilliseconds?: number,
  onProgress?: (percent: number) => void,
  outputProfile: RuntimeOutputProfile = "default",
  signal?: AbortSignal,
): Promise<VideoInput<InputFrameSource>> {
  throwIfAborted(signal);
  if (!file) {
    const width = 1920;
    const height = 1080;
    const fallbackCanvas = new OffscreenCanvas(width, height);
    const fallbackContext = fallbackCanvas.getContext("2d");

    return {
      kind: "image",
      sourceName: "untitled",
      mimeType: "image/png",
      source: fallbackCanvas,
      framerate: 30,
      resolution: [width, height],
      bitrate: 0,
      duration: 1000 / 30,
      onFrame(callback) {
        if (!fallbackContext) {
          throw new Error("当前浏览器不支持 OffscreenCanvas 2D 上下文");
        }
        const meta: FrameMeta = {
          index: 1,
          total: 1,
          currentTime: 1000 / 30,
          duration: 1000 / 30,
          progress: 100,
        };
        invokeFrameCallback(callback, fallbackCanvas, meta);
      },
      async start() {},
      output() {
        return createCanvasOutput(width, height, "image/png", 8_000_000);
      },
    };
  }

  if (file.type.startsWith("video/")) {
    throwIfAborted(signal);
    const inputFile = new Input({
      source: new BlobSource(file),
      formats: ALL_FORMATS,
    });

    const primaryVideoTrack = await inputFile.getPrimaryVideoTrack();
    const primaryAudioTrack = await inputFile.getPrimaryAudioTrack();
    if (!primaryVideoTrack) {
      inputFile.dispose();
      throw new Error("输入文件中没有可用的视频轨道");
    }

    const sourceWidth = Math.max(2, primaryVideoTrack.displayWidth || 1280);
    const sourceHeight = Math.max(2, primaryVideoTrack.displayHeight || 720);
    const scaled = scaleResolutionForProfile(sourceWidth, sourceHeight, outputProfile);
    const width = scaled.width;
    const height = scaled.height;
    const sourceTrackStats = await readVideoTrackStats(primaryVideoTrack);
    const preferredFps = clamp(sourceTrackStats.averagePacketRate, 1, 60);
    const sourceDurationSeconds = await inputFile.computeDuration();
    const sourceDurationMs = Number.isFinite(sourceDurationSeconds)
      ? Math.round(sourceDurationSeconds * 1000)
      : 0;
    const maxDurationMs =
      typeof maxDurationMilliseconds === "number" && Number.isFinite(maxDurationMilliseconds)
        ? Math.round(maxDurationMilliseconds)
        : undefined;
    const durationLimitMs =
      maxDurationMs !== undefined
        ? Math.max(100, Math.min(sourceDurationMs || maxDurationMs, maxDurationMs))
        : Math.max(100, sourceDurationMs || 100);
    const sourceBitrate =
      sourceTrackStats.averageBitrate > 0
        ? sourceTrackStats.averageBitrate
        : Math.max(
            1,
            Math.round(
              (file.size * 8) / Math.max((sourceDurationMs || durationLimitMs) / 1000, 0.1),
            ),
          );
    const bitrate = resolveTargetBitrate({
      sourceBitrate,
      width,
      height,
      profile: outputProfile,
    });
    const canvasSink = new CanvasSink(primaryVideoTrack, { width, height, fit: "contain" });
    const sourceCanvas = new OffscreenCanvas(width, height);
    const sourceContext = sourceCanvas.getContext("2d");
    if (!sourceContext) {
      inputFile.dispose();
      throw new Error("当前浏览器不支持 OffscreenCanvas 2D 上下文");
    }
    const shouldCopyAudio = outputProfile !== "preview-fast";

    let frameCallback: FrameCallback<InputFrameSource> | null = null;
    const mediaOutput = await createMediabunnyOutput(
      width,
      height,
      preferredFps,
      bitrate,
      durationLimitMs,
      shouldCopyAudio ? primaryAudioTrack : null,
      onProgress,
      signal,
    );
    let inputDisposed = false;
    const disposeInput = () => {
      if (inputDisposed) return;
      inputDisposed = true;
      inputFile.dispose();
    };

    return {
      kind: "video",
      sourceName: file.name,
      mimeType: "video/mp4",
      source: sourceCanvas,
      framerate: mediaOutput.actualFramerate,
      resolution: [width, height],
      bitrate,
      duration: durationLimitMs,
      onFrame(callback) {
        frameCallback = callback;
      },
      async start() {
        if (!frameCallback) {
          disposeInput();
          return;
        }

        const framerate = Math.max(1, mediaOutput.actualFramerate);
        const frameStepMs = 1000 / framerate;
        const totalFrames = Math.max(1, Math.ceil(durationLimitMs / frameStepMs));
        const drainInterval = outputProfile === "preview-fast" ? 12 : 6;
        let pushedSinceDrain = 0;
        let lastFrameSource: OffscreenCanvas | null = null;
        let completed = false;
        try {
          for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
            throwIfAborted(signal);
            const timelineSeconds = Math.min(durationLimitMs / 1000, frameIndex / framerate);
            const targetTimestampSeconds = timelineSeconds;
            const targetTimestampMs = targetTimestampSeconds * 1000;
            const wrappedCanvas = await canvasSink.getCanvas(targetTimestampSeconds);
            if (wrappedCanvas?.canvas) {
              lastFrameSource = wrappedCanvas.canvas as OffscreenCanvas;
            }

            const frameSource = wrappedCanvas?.canvas ?? lastFrameSource;
            if (!frameSource) {
              continue;
            }

            const callback = frameCallback;
            if (!callback) {
              break;
            }

            sourceContext.clearRect(0, 0, width, height);
            sourceContext.drawImage(frameSource, 0, 0, width, height);

            mediaOutput.setNextFrameTimestamp(targetTimestampSeconds);

            invokeFrameCallback(callback, sourceCanvas, {
              index: frameIndex + 1,
              total: totalFrames,
              currentTime: Math.round(targetTimestampMs),
              duration: Math.round(frameStepMs),
              progress: clamp(
                Math.round((targetTimestampMs / Math.max(durationLimitMs, frameStepMs)) * 100),
                0,
                100,
              ),
            });

            pushedSinceDrain += 1;
            if (pushedSinceDrain >= drainInterval) {
              await mediaOutput.waitForDrain();
              pushedSinceDrain = 0;
            }
          }

          await mediaOutput.waitForDrain();
          completed = true;
        } finally {
          // Keep input alive for output.finish() so tail audio packets can still be read.
          if (!completed) {
            disposeInput();
          }
        }
      },
      output() {
        const output = mediaOutput.output;
        return {
          source: output.source,
          push() {
            output.push();
          },
          async finish() {
            try {
              return await output.finish();
            } finally {
              disposeInput();
            }
          },
          framerate: output.framerate,
          resolution: output.resolution,
          bitrate: output.bitrate,
          duration: output.duration,
        };
      },
    };
  }

  throwIfAborted(signal);
  const bitmap = await createImageBitmap(file);
  const width = bitmap.width;
  const height = bitmap.height;
  const sourceCanvas = new OffscreenCanvas(width, height);
  const sourceContext = sourceCanvas.getContext("2d");
  if (!sourceContext) {
    bitmap.close();
    throw new Error("当前浏览器不支持 OffscreenCanvas 2D 上下文");
  }
  sourceContext.clearRect(0, 0, width, height);
  sourceContext.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  return {
    kind: "image",
    sourceName: file.name,
    mimeType: getMimeType(file.type),
    source: sourceCanvas,
    framerate: 30,
    resolution: [width, height],
    bitrate: file.size * 8,
    duration: 1000 / 30,
    onFrame(callback) {
      const meta: FrameMeta = {
        index: 1,
        total: 1,
        currentTime: 1000 / 30,
        duration: 1000 / 30,
        progress: 100,
      };
      invokeFrameCallback(callback, sourceCanvas, meta);
    },
    async start() {},
    output() {
      return createCanvasOutput(width, height, getMimeType(file.type), file.size * 8);
    },
  };
}

export async function executeTemplateApp(options: {
  app: TemplateDefaultExport;
  config?: Record<string, unknown>;
  mediaFile?: File;
  maxDurationMilliseconds?: number;
  outputProfile?: RuntimeOutputProfile;
  logger: RuntimeLogger;
  signal?: AbortSignal;
}) {
  await ensureWebCodecsPolyfill();
  ensureWebCodecsLifecycleGuards();
  ensurePixiRuntimeLifecycleGuards();
  ensurePixiRuntimeEnvironment();

  const progressBridge = createFrameProgressBridge(options.logger.progress);
  const input = await createMediaInput(
    options.mediaFile,
    options.maxDurationMilliseconds,
    (percent) => progressBridge.reportTemplateProgress(percent),
    options.outputProfile ?? "default",
    options.signal,
  );
  const inputForTemplate = createProgressAwareInput(
    input,
    (meta) => progressBridge.enterFrame(meta),
    () => progressBridge.leaveFrame(),
  );
  const loggerForTemplate: RuntimeLogger = {
    ...options.logger,
    progress: (percent: number) => progressBridge.reportTemplateProgress(percent),
  };
  throwIfAborted(options.signal);
  const value = await options.app(options.config ?? {}, inputForTemplate, loggerForTemplate);
  throwIfAborted(options.signal);
  options.logger.progress?.(100);
  return value;
}

export async function loadTemplateModule(
  files: TemplateWorkspaceFiles,
  entry = "index.ts",
): Promise<{
  app: TemplateDefaultExport;
  configCtor?: TemplateConfigCtor;
  moduleOrder: string[];
}> {
  ensureWebCodecsLifecycleGuards();
  ensurePixiRuntimeLifecycleGuards();
  ensurePixiRuntimeEnvironment();

  const bundle = await compileTemplateWorkspace(files, entry);

  (
    globalThis as typeof globalThis & { __templateBuiltins?: Record<string, unknown> }
  ).__templateBuiltins = {
    schema: { schema, scheme, getSchemaFields },
    "pixi.js": PIXI,
    typings: {},
  };

  const runner = new Function("globalThis", bundle.code) as (
    globalLike: typeof globalThis,
  ) => unknown;
  const moduleExports = runner(globalThis) as {
    default?: TemplateDefaultExport;
    Config?: TemplateConfigCtor;
  };

  if (!moduleExports || typeof moduleExports.default !== "function") {
    throw new Error("模板默认导出必须是函数: export default async function App(...) {}");
  }

  return {
    app: moduleExports.default,
    configCtor: moduleExports.Config,
    moduleOrder: bundle.moduleOrder,
  };
}

export function extractTemplateConfigFields(configCtor?: TemplateConfigCtor) {
  if (!configCtor) return [];

  let instance: unknown;
  try {
    instance = new configCtor();
  } catch {
    instance = undefined;
  }

  const fields = getSchemaFields(configCtor);
  const rawFields =
    fields.length > 0 ? fields : instance ? getSchemaFields(instance as object) : [];

  if (!instance || typeof instance !== "object") {
    return rawFields;
  }

  const defaultsSource = instance as Record<string, unknown>;
  return rawFields.map((field) => {
    const initializedValue = defaultsSource[field.key];
    if (initializedValue === undefined) {
      return field;
    }

    const normalizedDefault = normalizeInitializedValueForField(field, initializedValue);
    if (normalizedDefault === undefined) {
      return field;
    }

    return {
      ...field,
      default: normalizedDefault,
    };
  });
}

function normalizeInitializedValueForField(field: SchemaField, value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  if (field.kind === "rgb") {
    return {
      r: Number(source.r ?? 0),
      g: Number(source.g ?? 0),
      b: Number(source.b ?? 0),
    };
  }
  if (field.kind === "rgba") {
    return {
      r: Number(source.r ?? 0),
      g: Number(source.g ?? 0),
      b: Number(source.b ?? 0),
      a: Number(source.a ?? 1),
    };
  }
  if (field.kind === "size") {
    return {
      width: Number(source.width ?? 0),
      height: Number(source.height ?? 0),
    };
  }
  if (field.kind === "coord") {
    return {
      x: Number(source.x ?? 0),
      y: Number(source.y ?? 0),
    };
  }

  return undefined;
}

export function serializeSchemaField(field: SchemaField): EvaluatedConfigFieldDescriptor {
  return {
    key: field.key,
    name: field.name,
    description: field.description,
    kind: field.kind,
    required: field.required,
    default: field.default,
    options: field.options,
    group: field.group,
    groupPath: field.groupPath,
    gridIndex: field.gridIndex,
  };
}

export function evaluateTemplateConfig(fields: SchemaField[], config?: Record<string, unknown>) {
  const normalizedConfig = normalizeSchemaConfig(fields, config ?? {});
  const enabledFields = getEnabledSchemaFields(fields, normalizedConfig);
  return {
    normalizedConfig,
    configFields: enabledFields.map(serializeSchemaField),
  };
}

export async function runTemplateWithWorkspace(options: {
  files: TemplateWorkspaceFiles;
  config?: Record<string, unknown>;
  mediaFile?: File;
  maxDurationMilliseconds?: number;
  outputProfile?: RuntimeOutputProfile;
  logger?: RuntimeLogger;
  logPrefix?: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const prefix = options.logPrefix ?? "template-main-thread";
  const logger =
    options.logger ??
    ({
      info: (...args: unknown[]) => console.info(`[${prefix}]`, ...args),
      error: (...args: unknown[]) => console.error(`[${prefix}]`, ...args),
      progress: () => undefined,
    } satisfies RuntimeLogger);

  try {
    logger.info("模板执行开始");
    const { app } = await loadTemplateModule(options.files, "index.ts");
    const value = await executeTemplateApp({
      app,
      config: options.config,
      mediaFile: options.mediaFile,
      maxDurationMilliseconds: options.maxDurationMilliseconds,
      outputProfile: options.outputProfile,
      logger,
      signal: options.signal,
    });
    logger.info("模板执行完成");
    return { ok: true, value };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "模板执行已取消" };
    }
    logger.error("模板执行失败", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "模板执行失败",
    };
  }
}

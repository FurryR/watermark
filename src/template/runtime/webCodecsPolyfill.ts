import libavWasmUrl from "@uwx/libav.js-all/backend/all.wasm?url";

let polyfillLoadPromise: Promise<boolean> | undefined;
/** 已加载的 polyfill 模块（含 WebCodecs 类实现），用于调试时强制覆盖原生。 */
let polyfillModuleRef: Record<string, unknown> | undefined;
let polyfillNeededResolved = false;

const REQUIRED_NATIVE_CLASSES = [
  "VideoEncoder",
  "VideoDecoder",
  "AudioEncoder",
  "AudioDecoder",
  "VideoFrame",
  "AudioData",
  "EncodedVideoChunk",
  "EncodedAudioChunk",
] as const;

type WebCodecsClassName = (typeof REQUIRED_NATIVE_CLASSES)[number];

export function isNativeWebCodecsAvailable(): boolean {
  if (typeof globalThis === "undefined") return true;
  return REQUIRED_NATIVE_CLASSES.every((name) => name in globalThis);
}

export function isWebCodecsPolyfillNeeded(): boolean {
  return !isNativeWebCodecsAvailable();
}

// 被强制覆盖的原生实现，用于关闭调试开关时恢复。
let overriddenNatives: Partial<Record<WebCodecsClassName, unknown>> | null = null;

function applyPolyfillOverrides() {
  if (!polyfillModuleRef) return;
  overriddenNatives = overriddenNatives ?? {};
  for (const name of REQUIRED_NATIVE_CLASSES) {
    const implementation = polyfillModuleRef[name];
    if (!implementation) continue;
    // 仅记录确实存在的原生实现，避免关闭开关时把缺失的类恢复成 undefined。
    if (!(name in overriddenNatives) && name in globalThis) {
      overriddenNatives[name] = (globalThis as Record<string, unknown>)[name];
    }
    (globalThis as Record<string, unknown>)[name] = implementation;
  }
}

function restoreNativeOverrides() {
  if (!overriddenNatives) return;
  for (const name of REQUIRED_NATIVE_CLASSES) {
    if (name in overriddenNatives) {
      (globalThis as Record<string, unknown>)[name] = overriddenNatives[name];
    }
  }
  overriddenNatives = null;
}

// @uwx/libav.js-all 的 Emscripten 胶水代码在严格模式下会走 `global._scriptDir = undefined`
// 分支（浏览器无 `global`，直接 ReferenceError）。这里补一个 `global -> globalThis` 别名。
function ensureGlobalAlias() {
  const scope = globalThis as typeof globalThis & { global?: typeof globalThis };
  if (typeof scope.global === "undefined") {
    scope.global = scope;
  }
}

function loadPolyfillModule(): Promise<Record<string, unknown>> {
  if (polyfillModuleRef) {
    return Promise.resolve(polyfillModuleRef);
  }
  ensureGlobalAlias();
  return Promise.all([
    import("libavjs-webcodecs-polyfill"),
    import("@uwx/libav.js-all"),
    import("libav-wasm-factory"),
  ]).then(([polyfillModule, libavModule, factoryModule]) => {
    const libav = libavModule.default as never;
    const factory = factoryModule.default as never;
    return polyfillModule
      .load({
        polyfill: true,
        LibAV: libav,
        libavOptions: {
          noworker: true,
          factory,
          // 显式指定 wasm 资源地址：dev 下预打包的 libav factory 会按
          // import.meta.url 推导出 /node_modules/.vite/deps/... 下不存在的路径。
          wasmurl: libavWasmUrl,
        },
      })
      .then(() => {
        polyfillModuleRef = polyfillModule as unknown as Record<string, unknown>;
        return polyfillModuleRef;
      });
  });
}

/**
 * 加载 libavjs 软解/软编 polyfill。
 *
 * - 默认仅在浏览器缺少原生 WebCodecs 时加载，原生可用则直接跳过，不产生额外请求。
 * - `force` 为 true 时（调试用“使用软件解码”），即使原生可用，也会用 polyfill 覆盖
 *   全局的 WebCodecs 类，强制走 libav.js 软件编解码；关闭时恢复原生实现。
 *
 * 幂等，可在 worker 与主线程复用。
 */
export function ensureWebCodecsPolyfill(options?: { force?: boolean }): Promise<boolean> {
  const force = Boolean(options?.force);

  if (!force) {
    restoreNativeOverrides();
    if (!isWebCodecsPolyfillNeeded()) {
      polyfillNeededResolved = true;
      return Promise.resolve(false);
    }
  }

  if (!polyfillLoadPromise) {
    polyfillLoadPromise = loadPolyfillModule()
      .then(() => {
        polyfillNeededResolved = true;
        return true;
      })
      .catch((error) => {
        console.warn("[WebCodecs] polyfill 加载失败，退回原生能力", error);
        polyfillNeededResolved = true;
        return false;
      });
  }

  return polyfillLoadPromise.then((loaded) => {
    if (force && loaded) {
      applyPolyfillOverrides();
    }
    return loaded;
  });
}

export function didResolveWebCodecsPolyfill(): boolean {
  return polyfillNeededResolved;
}

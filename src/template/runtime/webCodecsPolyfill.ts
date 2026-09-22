import libavWasmUrl from "@uwx/libav.js-all/backend/all.wasm?url";

let polyfillLoadPromise: Promise<boolean> | undefined;
/** 已加载的 polyfill 模块（含 WebCodecs 类实现），用于调试时强制覆盖原生。 */
let polyfillModuleRef: Record<string, unknown> | undefined;
let polyfillNeededResolved = false;
/**
 * 运行时自动回落标记：当原生能力不足以处理当前媒体（缺少对应解码器/编码器）时，
 * 会加载 libav polyfill 覆盖全局 WebCodecs 类。该标记保证后续同一会话内不会被
 * `ensureWebCodecsPolyfill()`（默认 force=false）误恢复成原生实现。
 */
let softwareWebCodecsActive = false;

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
 * - 一旦因为运行时自动回落（{@link activateSoftwareWebCodecs}）激活过软件实现，
 *   后续调用即使未显式 `force` 也会继续保持软件实现，避免同一会话中途被恢复成原生。
 *
 * 幂等，可在 worker 与主线程复用。
 */
export function ensureWebCodecsPolyfill(options?: { force?: boolean }): Promise<boolean> {
  const force = Boolean(options?.force);

  if (!force && !softwareWebCodecsActive) {
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
    // 只要 polyfill 被加载（因缺少原生类 / 强制软件 / 运行时回落），就用其实现
    // 覆盖全部 WebCodecs 类。polyfill 自身的 load({polyfill:true}) 只会补齐缺失的类
    // （`if (!globalThis[name])`），无法替换“存在但能力不足”的原生实现——例如
    // Firefox for Android 有 VideoEncoder 却不支持 H.264。混合原生 VideoFrame 与
    // 软件编解码器也会导致不兼容，因此这里必须整体覆盖。
    if (loaded) {
      applyPolyfillOverrides();
    }
    return loaded;
  });
}

/**
 * 运行时自动回落：当原生 WebCodecs 无法处理当前媒体时，加载 libav polyfill 并用其
 * 覆盖全局 WebCodecs 类。加载/覆盖成功后，该会话内软件实现保持激活，不会被
 * {@link ensureWebCodecsPolyfill} 恢复。
 *
 * 返回是否成功启用了软件实现。
 */
export function activateSoftwareWebCodecs(): Promise<boolean> {
  return ensureWebCodecsPolyfill({ force: true }).then((loaded) => {
    if (loaded) {
      softwareWebCodecsActive = true;
      return true;
    }
    return false;
  });
}

export function isSoftwareWebCodecsActive(): boolean {
  return softwareWebCodecsActive;
}

export function didResolveWebCodecsPolyfill(): boolean {
  return polyfillNeededResolved;
}

let polyfillLoadPromise: Promise<boolean> | undefined;
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

export function isNativeWebCodecsAvailable(): boolean {
  if (typeof globalThis === "undefined") return true;
  return REQUIRED_NATIVE_CLASSES.every((name) => name in globalThis);
}

export function isWebCodecsPolyfillNeeded(): boolean {
  return !isNativeWebCodecsAvailable();
}

/**
 * 仅在浏览器缺少原生 WebCodecs 时加载 libavjs 软解/软编 polyfill。
 * 若原生可用则直接跳过，不产生额外请求。幂等，可在 worker 与主线程复用。
 */
export function ensureWebCodecsPolyfill(): Promise<boolean> {
  if (!isWebCodecsPolyfillNeeded()) {
    polyfillNeededResolved = true;
    return Promise.resolve(false);
  }
  if (!polyfillLoadPromise) {
    polyfillLoadPromise = Promise.all([
      import("libavjs-webcodecs-polyfill"),
      import("@libav.js/variant-webm-vp9"),
      import("libav-asm-factory"),
    ])
      .then(([{ load }, libavModule, asmModule]) => {
        const libav = libavModule.default as never;
        const asmFactory = asmModule.default as never;
        return load({
          polyfill: true,
          LibAV: libav,
          libavOptions: {
            noworker: true,
            nowasm: true,
            factory: asmFactory,
          },
        });
      })
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
  return polyfillLoadPromise;
}

export function didResolveWebCodecsPolyfill(): boolean {
  return polyfillNeededResolved;
}

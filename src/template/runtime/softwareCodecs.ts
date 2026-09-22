/**
 * libav.js 软件编解码器注册表（见 patches/libavjs-webcodecs-polyfill@0.5.5.patch）
 * 覆盖的媒体编码。原生 WebCodecs 无法处理时，这些编码可以回落到软件实现。
 *
 * 该模块刻意不引入 wasm 资源，便于主线程 / 渲染层安全复用。
 */
const SOFTWARE_DECODABLE_VIDEO_CODECS = new Set(["avc", "hevc", "vp9", "av1", "vp8"]);
const SOFTWARE_DECODABLE_AUDIO_CODECS = new Set(["flac", "opus", "vorbis"]);

export function canSoftwareDecodeVideoCodec(codec: string): boolean {
  return SOFTWARE_DECODABLE_VIDEO_CODECS.has(codec);
}

export function canSoftwareDecodeAudioCodec(codec: string): boolean {
  return SOFTWARE_DECODABLE_AUDIO_CODECS.has(codec);
}

function getCodecStringPrefix(codecString: string): string {
  return codecString.trim().toLowerCase().split(".")[0] ?? "";
}

export function inferVideoCodecFromString(codecString: string): string | null {
  switch (getCodecStringPrefix(codecString)) {
    case "avc1":
    case "avc3":
      return "avc";
    case "hev1":
    case "hvc1":
      return "hevc";
    case "vp09":
      return "vp9";
    case "vp08":
    case "vp8":
      return "vp8";
    case "av01":
      return "av1";
    default:
      return null;
  }
}

export function inferAudioCodecFromString(codecString: string): string | null {
  switch (getCodecStringPrefix(codecString)) {
    case "opus":
      return "opus";
    case "vorbis":
      return "vorbis";
    case "flac":
      return "flac";
    default:
      return null;
  }
}

export function isSoftwareDecodableVideoCodecString(codecString: string): boolean {
  const codec = inferVideoCodecFromString(codecString);
  return codec !== null && canSoftwareDecodeVideoCodec(codec);
}

export function isSoftwareDecodableAudioCodecString(codecString: string): boolean {
  const codec = inferAudioCodecFromString(codecString);
  return codec !== null && canSoftwareDecodeAudioCodec(codec);
}

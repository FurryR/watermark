declare module "libav-asm-factory" {
  const factory: unknown;
  export default factory;
}

declare module "libavjs-webcodecs-polyfill" {
  export interface WebCodecsLoadOptions {
    polyfill?: boolean;
    LibAV?: unknown;
    libavOptions?: unknown;
  }

  export function load(options?: WebCodecsLoadOptions): Promise<void>;

  export const VideoEncoder: unknown;
  export const VideoDecoder: unknown;
  export const AudioEncoder: unknown;
  export const AudioDecoder: unknown;
  export const VideoFrame: unknown;
  export const AudioData: unknown;
  export const EncodedVideoChunk: unknown;
  export const EncodedAudioChunk: unknown;
}

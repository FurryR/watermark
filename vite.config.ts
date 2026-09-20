import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as {
  version?: string;
};

// 把体积大且带副作用（扩展注册）的第三方库单独拆成 chunk。
// Safari/WebKit 存在模块 worker 入口被二次求值的缺陷：当 worker 入口 chunk
// 承载了这些共享副作用代码、又被其它 chunk（如 pixi 的 browserAll/webworkerAll）
// 反向 import 时，入口会被求值两次，导致 pixi 扩展重复注册并抛出
// "Extension type application already has a handler"。主构建与 worker 构建都要拆。
const vendorCodeSplittingGroups = [
  { name: "vendor-pixi", test: /[\\/]node_modules[\\/]pixi\.js[\\/]/ },
  { name: "vendor-mediabunny", test: /[\\/]node_modules[\\/]mediabunny[\\/]/ },
  { name: "vendor-babel", test: /[\\/]node_modules[\\/]@babel[\\/]/ },
  { name: "vendor-monaco", test: /[\\/]node_modules[\\/]monaco-editor[\\/]/ },
];

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version ?? "0.0.0"),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "pwa-icon.svg"],
      manifest: {
        name: "水印",
        short_name: "水印",
        description: "离线可用的图片和视频动态水印工具",
        theme_color: "#355ec9",
        background_color: "#f3f7ff",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/pwa-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "/pwa-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
        ],
      },
      workbox: {
        // libav.js 软解/软编的 wasm 约 15 MB，需放宽单文件上限才能被预缓存。
        maximumFileSizeToCacheInBytes: 24 * 1024 * 1024,
        globPatterns: ["**/*.{js,css,html,svg,png,ico,wasm}"],
        navigateFallback: "/index.html",
        runtimeCaching: [
          {
            urlPattern: ({ request }) =>
              request.destination === "image" || request.destination === "video",
            handler: "CacheFirst",
            options: {
              cacheName: "media-cache",
              expiration: { maxEntries: 48, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    sourcemap: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: vendorCodeSplittingGroups,
        },
      },
    },
  },
  resolve: {
    alias: {
      schema: fileURLToPath(new URL("./src/template/schema/index.ts", import.meta.url)),
      "libav-wasm-factory": fileURLToPath(
        new URL(
          "./node_modules/@uwx/libav.js-all/dist/libav-6.0.0-nightly.29.f420ff.ffmpeg.6.1.1-all.wasm.mjs",
          import.meta.url,
        ),
      ),
    },
  },
  worker: {
    format: "es",
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: vendorCodeSplittingGroups,
        },
      },
    },
  },
});

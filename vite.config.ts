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
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
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
          groups: [
            { name: "vendor-pixi", test: /[\\/]node_modules[\\/]pixi\.js[\\/]/ },
            { name: "vendor-mediabunny", test: /[\\/]node_modules[\\/]mediabunny[\\/]/ },
            { name: "vendor-babel", test: /[\\/]node_modules[\\/]@babel[\\/]/ },
            { name: "vendor-monaco", test: /[\\/]node_modules[\\/]monaco-editor[\\/]/ },
          ],
        },
      },
    },
  },
  resolve: {
    alias: {
      schema: fileURLToPath(new URL("./src/template/schema/index.ts", import.meta.url)),
      "libav-asm-factory": fileURLToPath(
        new URL(
          "./node_modules/@libav.js/variant-webm-vp9/dist/libav-6.7.7.1.1-webm-vp9.asm.mjs",
          import.meta.url,
        ),
      ),
    },
  },
  worker: {
    format: "es",
  },
});

import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    remix({
      ignoredRouteFiles: ["**/*.css"],
      // Server build configuration
      serverBuildFile: "index.js",
      serverModuleFormat: "esm",
    }),
    tsconfigPaths(),
  ],
  ssr: {
    noExternal: ["@shopify/shopify-app-remix"],
  },
  build: {
    target: "node20",
    rollupOptions: {
      // Externalize all Node.js built-in modules
      external: [
        /^node:/, // This externalizes all node:* modules
        "crypto",
        "fs",
        "buffer",
        "stream",
        "http",
        "https",
        "net",
        "util",
        "events",
        "url",
        "zlib",
        "assert",
        "dns",
        "querystring",
        "worker_threads",
      ],
    },
  },
  // Tell Vite to treat these as external
  optimizeDeps: {
    exclude: [
      "crypto",
      "fs",
      "buffer",
      "stream",
      "http",
      "https",
      "net",
      "util",
      "events",
      "url",
      "zlib",
      "assert",
      "dns",
      "querystring",
      "worker_threads",
    ],
  },
});

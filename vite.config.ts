import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
// `vitest/config` rather than `vite`: same `defineConfig`, plus the `test`
// key's types. Vitest reads this file for the `@` alias and the React plugin
// anyway, so keeping one config avoids the two drifting apart.
import { defineConfig } from "vitest/config";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  build: {
    rollupOptions: {
      output: {
        // Split big, independently-cacheable vendor groups out of the entry
        // chunk so a code change doesn't bust the whole bundle and rarely-used
        // libs (charts, markdown, syntax highlighting) load on demand.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (/recharts|d3-|victory|internmap/.test(id)) return "charts";
          if (/react-markdown|remark|rehype|micromark|mdast|hast|unist|unified/.test(id))
            return "markdown";
          if (/refractor|prismjs|highlight\.js/.test(id)) return "prism";
          if (/@tanstack/.test(id)) return "tanstack";
          if (/react-dom|react\/|scheduler/.test(id)) return "react";
        },
      },
    },
  },
  test: {
    // Most suites are pure functions and don't need a DOM, but the diff →
    // context-pane path is built on Range/Selection and the `data-diff-row`
    // attributes, which only mean anything in one. jsdom implements enough of
    // both (`containsNode`, `compareBoundaryPoints`) to test it honestly.
    //
    // Note jsdom does no layout: every box measures 0×0 and `scrollIntoView` is
    // a no-op, so anything that depends on real geometry belongs in a manual
    // pass on a real PR, not here.
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));

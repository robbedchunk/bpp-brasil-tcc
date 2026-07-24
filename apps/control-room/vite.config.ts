import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/web", import.meta.url)),
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4317,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4318",
    },
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    sourcemap: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          minSize: 20_000,
          groups: [
            { name: "react-core", test: /node_modules\/(?:react|react-dom|scheduler)\//u },
            { name: "tanstack", test: /node_modules\/@tanstack\//u },
            { name: "radix", test: /node_modules\/@radix-ui\//u },
            { name: "icons", test: /node_modules\/lucide-react\//u },
            { name: "class-utils", test: /node_modules\/(?:clsx|tailwind-merge|class-variance-authority)\//u },
            { name: "charts", test: /node_modules\/(?:recharts|d3-|victory-vendor|react-smooth)/u },
          ],
        },
      },
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});

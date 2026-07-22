import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@supabase")) return "supabase";
          if (id.includes("@phosphor-icons")) return "icons";
          if (id.includes("react") || id.includes("scheduler")) {
            return "react-vendor";
          }
          return undefined;
        },
      },
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  test: {
    environment: "jsdom",
  },
  plugins: [react()],
});

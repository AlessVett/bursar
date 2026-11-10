import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
    // Vitest replaces CSS with an empty string by default; the token tests need the real text.
    css: { include: [/\.css\?raw$/] },
  },
});

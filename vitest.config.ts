import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

// Pure-logic tests only: run in Node (jsdom is not installed).
export default defineConfig({
  plugins: [solid()],
  test: { environment: "node" },
});

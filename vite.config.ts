import { cloudflare } from "@cloudflare/vite-plugin";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [
    preact(),
    cloudflare({ persistState: mode !== "e2e" }),
  ],
  build: {
    sourcemap: true,
  },
}));

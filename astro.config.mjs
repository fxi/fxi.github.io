import { defineConfig } from "astro/config";
import { loadEnv } from "vite";
import react from "@astrojs/react";
import mdx from "@astrojs/mdx";

// loadEnv reads .env before Vite processes it, so process.env isn't populated yet
const env = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");

export default defineConfig({
  integrations: [react(), mdx()],
  site: "https://fxi.io",
  base: "/",
  vite: {
    define: {
      "import.meta.env.PUBLIC_MAPTILER_KEY": JSON.stringify(
        env.MAPTILER_KEY ?? process.env.MAPTILER_KEY ?? "",
      ),
    },
  },
});

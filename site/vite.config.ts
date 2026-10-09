import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  // Project-page URL is https://<user>.github.io/vivliostyle-batch-cli/;
  // override with SITE_BASE when serving elsewhere.
  base: process.env.SITE_BASE ?? "/vivliostyle-batch-cli/",
  build: {
    outDir: "../dist-site",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        fixtures: resolve(__dirname, "fixtures.html")
      }
    }
  }
});

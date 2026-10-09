import { defineConfig } from "vite";

export default defineConfig({
  // Project-page URL is https://<user>.github.io/vivliostyle-batch-cli/;
  // override with SITE_BASE when serving elsewhere.
  base: process.env.SITE_BASE ?? "/vivliostyle-batch-cli/",
  build: {
    outDir: "../dist-site",
    emptyOutDir: true
  }
});

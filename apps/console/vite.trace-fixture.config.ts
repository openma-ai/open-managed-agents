/**
 * One-off build for a backend-free, file://-openable Trace fixture.
 * Does not change the production `vite build` of index.html.
 *
 *   npx vite build --config vite.trace-fixture.config.ts
 *
 * Output: dist-trace-fixture/trace-fixture.html (JS/CSS inlined). The page
 * renders synthetic demo data only (src/dev/trace-fixture.tsx), for review.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import fs from "node:fs";

const outDir = path.resolve(__dirname, "dist-trace-fixture");

function inlineSingleFile() {
  return {
    name: "inline-single-file",
    closeBundle() {
      const htmlPath = path.join(outDir, "trace-fixture.html");
      if (!fs.existsSync(htmlPath)) {
        throw new Error(`expected ${htmlPath}`);
      }
      let html = fs.readFileSync(htmlPath, "utf8");
      html = html.replace(/<link rel="modulepreload"[^>]*>\s*/g, "");
      html = html.replace(
        /<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g,
        (_m, href: string) => {
          const file = path.join(outDir, href.replace(/^\.\//, ""));
          return `<style>\n${fs.readFileSync(file, "utf8")}\n</style>`;
        },
      );
      html = html.replace(
        /<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g,
        (_m, src: string) => {
          const file = path.join(outDir, src.replace(/^\.\//, ""));
          return `<script type="module">\n${fs.readFileSync(file, "utf8")}\n</script>`;
        },
      );
      fs.writeFileSync(htmlPath, html);
      const assets = path.join(outDir, "assets");
      if (fs.existsSync(assets)) {
        for (const name of fs.readdirSync(assets)) {
          fs.unlinkSync(path.join(assets, name));
        }
        fs.rmdirSync(assets);
      }
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), inlineSingleFile()],
  resolve: {
    alias: {
      "@/registry/default/ui": path.resolve(__dirname, "./src/components/ui"),
      "@/registry/default/blocks": path.resolve(__dirname, "./src/components/blocks"),
      "@/registry/default/hooks": path.resolve(__dirname, "./src/hooks"),
      "@/registry/default/lib": path.resolve(__dirname, "./src/lib"),
      "@": path.resolve(__dirname, "./src"),
    },
  },
  publicDir: false,
  build: {
    outDir,
    emptyOutDir: true,
    assetsInlineLimit: 100 * 1024 * 1024,
    cssCodeSplit: false,
    rollupOptions: {
      input: path.resolve(__dirname, "trace-fixture.html"),
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});

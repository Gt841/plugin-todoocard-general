import { resolve } from "path";
import { homedir } from "os";
import { defineConfig } from "vite";
import minimist from "minimist";
import { viteStaticCopy } from "vite-plugin-static-copy";
import livereload from "rollup-plugin-livereload";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import zipPack from "vite-plugin-zip-pack";

const args = minimist(process.argv.slice(2));
const isWatch = args.watch || args.w || false;
const devDistDir = process.env.SIYUAN_PLUGIN_DIR
  ? resolve(process.env.SIYUAN_PLUGIN_DIR, "plugin-todoocard-general")
  : resolve(homedir(), "Library/Application Support/SiYuan/data/plugins/plugin-todoocard-general");
const distDir = isWatch ? devDistDir : "./dist";

export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  plugins: [
    svelte(),
    viteStaticCopy({ targets: [
      { src: "./README*.md", dest: "./" },
      { src: "./LICENSE", dest: "./" },
      { src: "./plugin.json", dest: "./" },
      { src: "./preview.png", dest: "./" },
      { src: "./icon.png", dest: "./" },
    ]}),
  ],
  define: {
    "process.env.DEV_MODE": `"${isWatch}"`,
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV),
  },
  build: {
    outDir: distDir, emptyOutDir: !isWatch, sourcemap: false, minify: !isWatch,
    lib: { entry: resolve(__dirname, "src/index.ts"), fileName: "index", formats: ["cjs"] },
    rollupOptions: {
      plugins: [ ...(isWatch ? [livereload(devDistDir)] : [zipPack({ inDir: "./dist", outDir: "./", outFileName: "package.zip" })]) ],
      external: ["siyuan", "process", "child_process", "fs", "path", "os", "crypto", "https", "http", "url", "electron"],      output: { entryFileNames: "[name].js", assetFileNames: (a) => a.name === "style.css" ? "index.css" : a.name },
    },
  },
});
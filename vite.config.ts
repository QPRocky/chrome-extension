import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Builds the extension HTML pages. Background and content scripts are built
// separately as IIFE bundles by scripts/build.mjs.
export default defineConfig({
  root: r('./src'),
  publicDir: r('./public'),
  build: {
    outDir: r('./dist'),
    emptyOutDir: false,
    target: 'chrome111',
    minify: false,
    sourcemap: true,
    modulePreload: { polyfill: false },
    rolldownOptions: {
      input: {
        devtools: r('./src/devtools/devtools.html'),
        panel: r('./src/panel/panel.html'),
      },
    },
  },
});

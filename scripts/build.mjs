import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = fileURLToPath(new URL('../dist', import.meta.url));
const watch = process.argv.includes('--watch');

// Content scripts in the MAIN world cannot be ES modules, so every script
// entry is bundled on its own into a self-contained IIFE.
const scripts = {
  background: 'src/background/index.ts',
  bridge: 'src/content/bridge.ts',
  'redux-hook': 'src/content/redux-hook.ts',
};

await rm(outDir, { recursive: true, force: true });

await build({
  configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
  build: { watch: watch ? {} : null },
});

for (const [name, entry] of Object.entries(scripts)) {
  await build({
    configFile: false,
    root,
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir,
      emptyOutDir: false,
      copyPublicDir: false,
      target: 'chrome111',
      minify: false,
      sourcemap: true,
      watch: watch ? {} : null,
      lib: {
        entry: entry,
        formats: ['iife'],
        name: `devkit_${name.replace(/-/g, '_')}`,
        fileName: () => `${name}.js`,
      },
    },
  });
  if (!watch) console.log(`built ${name}.js`);
}

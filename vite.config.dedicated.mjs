import { defineConfig } from 'vite';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'fs/promises';

import process from 'process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Plugin to adjust paths for the bundled dedicated server.
 *
 * Since the bundle output lives in dist/dedicated/ (two levels below project root),
 * we need to adjust path calculations that were designed for the unbundled layout
 * where source files live multiple levels deep.
 * @returns {import('vite').Plugin} Vite plugin
 */
function dedicatedServerPathsPlugin() {
  return {
    name: 'dedicated-server-paths',

    // Transform source files before bundling
    transform(code, id) {
      // In the entry point, strip the shebang (added back in renderChunk)
      // and adjust process.chdir to navigate up from dist/dedicated/ to project root
      if (id.endsWith('/dedicated.mjs')) {
        return {
          code: code
            .replace(/^#!.*\n/, '')
            .replace(
              "new URL('./', import.meta.url)",
              "new URL('../..', import.meta.url)",
            ),
          map: null,
        };
      }

      // In Sys.mjs, the __dirname calculation needs adjusting:
      // Unbundled: import.meta.dirname = <root>/source/engine/server (3 levels deep)
      //   + '/../..' goes up 2, then later code does + '/..' for a total of 3 up = root
      // Bundled: import.meta.dirname = <root>/dist/dedicated (2 levels deep)
      //   + '/..' goes up 1, then later code does + '/..' for a total of 2 up = root
      if (id.includes('/source/engine/server/Sys.mjs')) {
        return {
          code: code.replace(
            "import.meta.dirname + '/../..'",
            "import.meta.dirname + '/..'",
          ),
          map: null,
        };
      }

      // In WorkerFactories.mjs, rewrite worker URLs to point at self-contained
      // bundles that will be placed alongside the dedicated server output by
      // dedicatedWorkerBundlePlugin (see below).
      if (id.includes('WorkerFactories.mjs')) {
        return {
          code: code.replace(/'\.\.\/server\//g, "'./workers/"),
          map: null,
        };
      }

      return null;
    },

    // Add shebang to the output
    renderChunk(code, chunk) {
      if (chunk.isEntry) {
        return { code: '#!/usr/bin/env node\n' + code, map: null };
      }
      return null;
    },
  };
}

/**
 * Plugin to bundle worker scripts as self-contained ES modules.
 *
 * Worker threads in Node.js load their own module graph independently,
 * so they cannot share chunks with the main SSR bundle.  This plugin
 * runs a secondary Rollup build after the main one completes, producing
 * a standalone bundle for every *Worker.mjs file under source/engine/server/.
 *
 * The output lands in dist/dedicated/workers/ which the rewritten URLs
 * in WorkerFactories.mjs (see dedicatedServerPathsPlugin) point at.
 * @param {string} mode Vite build mode (development / production)
 * @returns {import('vite').Plugin} Vite plugin
 */
function dedicatedWorkerBundlePlugin(mode) {
  return {
    name: 'dedicated-worker-bundle',

    async closeBundle() {
      const { rollup } = await import('rollup');
      const { transformWithEsbuild } = await import('vite');
      const workerDir = resolve(__dirname, 'source/engine/server');
      const outDir = resolve(__dirname, 'dist/dedicated/workers');

      const workerPaths = [];
      for await (const entry of glob('*Worker.mjs', { cwd: workerDir })) {
        workerPaths.push(resolve(workerDir, entry));
      }

      if (workerPaths.length === 0) {
        return;
      }

      const bundle = await rollup({
        input: Object.fromEntries(
          workerPaths.map((p) => [basename(p, '.mjs'), p]),
        ),
        // Node built-ins stay external (both prefixed and bare); everything else is inlined
        external: [/^node:/, 'fs', 'path', 'os', 'url', 'util', 'crypto', 'stream', 'events', 'buffer', 'http', 'https', 'net', 'tls', 'child_process', 'worker_threads'],
        plugins: [
          {
            name: 'transpile-typescript-modules',
            async transform(code, id) {
              if (!/\.(ts|mts|cts)$/.test(id)) {
                return null;
              }

              return await transformWithEsbuild(code, id, {
                format: 'esm',
                loader: 'ts',
                sourcemap: mode !== 'production',
                target: 'node24',
              });
            },
          },
          {
            // WorkerFramework.mjs constructs dynamic import paths at runtime
            // to evade Vite's static analysis (e.g. ['..','server','Com.mjs'].join('/')).
            // We undo that here so Rollup can resolve and bundle them.
            name: 'resolve-worker-dynamic-imports',
            transform(code, id) {
              if (!id.includes('WorkerFramework')) { return null; }
              // Replace the two-step variable + import() patterns with direct
              // literal import() calls so Rollup can statically resolve them.
              return {
                code: code
                  .replace(
                    /const workerThreadsId\s*=\s*\[.*?\]\.join\([^)]+\);\s*const \{ parentPort \} = await import\(\/\* @vite-ignore \*\/ workerThreadsId\)/s,
                    "const { parentPort } = await import('node:worker_threads')",
                  )
                  .replace(
                    /const serverComId\s*=\s*\[.*?\]\.join\([^)]+\);\s*const comModule = await import\(\/\* @vite-ignore \*\/ serverComId\)/s,
                    "const comModule = await import('../server/Com.mjs')",
                  ),
                map: null,
              };
            },
          },
        ],
        // The engine source has pre-existing circular dependencies that
        // Vite silences in its own build.  Suppress them here too.
        onwarn(warning, defaultHandler) {
          if (warning.code === 'CIRCULAR_DEPENDENCY') {
            return;
          }
          defaultHandler(warning);
        },
      });

      await bundle.write({
        dir: outDir,
        format: 'es',
        entryFileNames: '[name].mjs',
        chunkFileNames: '[name]-[hash].mjs',
        sourcemap: mode !== 'production',
        compact: mode === 'production',
      });

      await bundle.close();
    },
  };
}

export default defineConfig(({ mode }) => ({
  esbuild: {
    drop: mode === 'production' ? ['debugger'] : [],
    pure: mode === 'production' ? ['console.log', 'console.debug', 'console.info', 'console.assert', 'console.trace'] : [],
  },
  build: {
    ssr: resolve(__dirname, 'dedicated.mjs'),
    outDir: resolve(__dirname, 'dist/dedicated'),
    emptyOutDir: true,
    target: 'node24',
    sourcemap: mode !== 'production',
    minify: mode === 'production' ? 'esbuild' : false,
    rollupOptions: {
      output: {
        format: 'es',
        entryFileNames: '[name].mjs',
        chunkFileNames: '[name]-[hash].mjs',
        // Extract shared engine/library code into a separate chunk so that
        // both the entry (dedicated.mjs) and game module chunks import from
        // it. Without this, Rollup puts shared code into the entry chunk,
        // causing game module chunks to import from dedicated.mjs — which
        // has a top-level await and creates an ESM evaluation deadlock.
        manualChunks(id) {
          if (id.includes('/source/engine/') || id.includes('/source/shared/')) {
            return 'engine';
          }

          return null;
        },
      },
    },
  },
  plugins: [
    dedicatedServerPathsPlugin(),
    dedicatedWorkerBundlePlugin(mode),
  ],
  define: {
    '__BUILD_SIGNALING_URL__': JSON.stringify(
      process.env.VITE_SIGNALING_URL || '',
    ),
    '__BUILD_CDN_URL_PATTERN__': JSON.stringify(
      process.env.VITE_CDN_URL_PATTERN || '',
    ),
    '__BUILD_MODE__': JSON.stringify(mode),
    '__BUILD_TIMESTAMP__': JSON.stringify(new Date().toISOString()),
    '__BUILD_COMMIT_HASH__': JSON.stringify(process.env.WORKERS_CI_COMMIT_SHA?.substring(0, 7) || null),
    '__BUILD_GAME_DIR__': JSON.stringify(process.env.VITE_GAME_DIR || null),
    '__DEV__': JSON.stringify(mode !== 'production'),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'source'),
    },
    extensions: ['.ts', '.mts', '.mjs', '.js', '.json'],
    preserveSymlinks: process.env.VITE_PRESERVE_SYMLINKS === 'true',
  },
}));

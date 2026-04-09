import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import process from 'process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Plugin to inject modulepreload hints for game module chunks.
 * That allows the browser to preload game modules in parallel during booting the game.
 * @returns {import('vite').Plugin} Vite plugin
 */
function gameModulePreloadPlugin() {
  return {
    name: 'game-module-preload',
    transformIndexHtml: {
      order: 'post',
      handler(html, { bundle }) {
        if (!bundle) {
          return html;
        }

        // Find all chunks that are game modules (from GameLoader)
        const gameModuleChunks = Object.values(bundle).filter(
          (chunk) =>
            chunk.type === 'chunk' &&
            chunk.facadeModuleId?.includes('/game/') &&
            chunk.facadeModuleId?.endsWith('/main.mjs') &&
            chunk.facadeModuleId?.endsWith('Worker.mjs'),
        );

        if (gameModuleChunks.length === 0) {
          return html;
        }

        const preloadLinks = gameModuleChunks
          .map((chunk) => `\t\t<link rel="modulepreload" href="/${chunk.fileName}" />`)
          .join('\n');

        return html.replace('</head>', `\n${preloadLinks}\n\t</head>`);
      },
    },
  };
}

export default defineConfig(({ mode }) => ({
  esbuild: {
    drop: mode === 'production' ? ['debugger'] : [],
    pure: mode === 'production' ? ['console.log', 'console.debug', 'console.info', 'console.assert', 'console.trace'] : [],
  },
  build: {
    outDir: resolve(__dirname, 'dist/browser'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
      output: {
        entryFileNames: 'libs/[name]-[hash].js',
        chunkFileNames: 'libs/[name]-[hash].js',
        assetFileNames: 'libs/[name]-[hash][extname]',
        manualChunks(id) {
          // bundle shared code into a single chunk
          if (id.includes('/source/shared/')) {
            return 'shared';
          }

          // vendor packages from node_modules
          if (id.includes('/node_modules/')) {
            return 'vendor';
          }

          // keep game modules as separate chunks (they are dynamically loaded by the PR code)
          if (id.includes('/source/game/')) {
            // extract the gamedir name
            const gameMatch = id.match(/\/source\/game\/([^/]+)\//);
            if (gameMatch) {
              return `game-${gameMatch[1]}`;
            }
          }

          // anything else
          return null;
        },
      },
    },
    copyPublicDir: true,
    sourcemap: mode !== 'production',
    chunkSizeWarningLimit: 1000,
    minify: mode === 'production' ? 'esbuild' : false,
    reportCompressedSize: true,
    target: 'es2022',
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: 'libs/worker-[name]-[hash].js',
        chunkFileNames: 'libs/worker-[name]-[hash].js',
      },
    },
  },
  plugins: [
    gameModulePreloadPlugin(),
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

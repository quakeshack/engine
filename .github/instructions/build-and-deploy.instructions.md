
## Build and Deployment

### Build Process

- In package.json are all depencencies and scripts needed for building the project.
- Use `npm install` to install dependencies.
- Use `npm run build:production` to build the project.
- Use `npm run typecheck` (`tsc -p tsconfig.json`) to type-check the engine, the game modules, and `source/shared/`. Vite and esbuild strip types without checking them, so `tsc` is the only step that catches a type error. `npm run check` runs it together with the linter.

### Deployment

- Output files will be in the `dist/` directory after a successful build.
- Build and Deployment is automatically done by Cloudflare Worker.
- The Cloudflare build runs `npm run build:wrangler`: `npm run typecheck`, then `npm test`, then `npm run build:production`. A type error or a failing test fails the deploy.

### Three different kinds of builds

All code is always compiled through esbuild (via Vite) before execution. This ensures full TypeScript feature support (decorators, const enum, etc.) across every environment.

1. Dedicated development server: Build with `npm run dedicated:dev` (Vite watch mode), run with `npm run dedicated:start`. The build step compiles TypeScript to JavaScript in `dist/dedicated/` with source maps enabled.
2. Dedicated production server: Build with `npm run dedicated:build:production` and run with `npm run dedicated:start`. Strips console.assert and other development-only code for optimal performance.
3. Client code: Build with `npm run build:production` and serve the output in `dist/browser/` to the browser.

### Testing

Tests use `tsx` (esbuild-based) as the Node.js loader, ensuring the same TypeScript compilation behavior as the Vite builds. Run with `npm test`. Neither the loader nor the tests type-check anything: run `npm run typecheck` separately (the Docker `test` stage does this in a `RUN npm run typecheck` step before the tests start).

### Keep the Dockerfile in sync

The `Dockerfile`'s `test` stage only has access to files it explicitly `COPY`s (plus what `.dockerignore` allows through) — it does not run `npm test` against the full working tree. Whenever you add or move test fixtures (new `data/` subdirectories, new map/texture/pak assets referenced via `import.meta.url` or `readFileSync` in a `.test.mjs` file), add a matching `COPY` line to the `test` stage, and check `.dockerignore` doesn't silently exclude the new path. The same applies to the build stages: any new top-level source file, config file, or directory required by `npm run build:production` / `npm run dedicated:build:production` must be added to the `builder` stage's `COPY` list. The `test` stage also runs `npm run typecheck`, so a file that a type-checked source file imports has to be copied there too, or the stage fails in Docker while `npm run typecheck` passes locally. Treat the Dockerfile as part of the change whenever it would otherwise drift from what `npm test`, the type check, or the build scripts actually need. See the `.claude/skills/dockerfile-fixture-sync/SKILL.md` skill for the check to run whenever a fixture or top-level file is added.


## Build and Deployment

### Build Process

- In package.json are all depencencies and scripts needed for building the project.
- Use `npm install` to install dependencies.
- Use `npm run build:production` to build the project.

### Deployment

- Output files will be in the `dist/` directory after a successful build.
- Build and Deployment is automatically done by Cloudflare Worker.

### Three different kinds of builds

All code is always compiled through esbuild (via Vite) before execution. This ensures full TypeScript feature support (decorators, const enum, etc.) across every environment.

1. Dedicated development server: Build with `npm run dedicated:dev` (Vite watch mode), run with `npm run dedicated:start`. The build step compiles TypeScript to JavaScript in `dist/dedicated/` with source maps enabled.
2. Dedicated production server: Build with `npm run dedicated:build:production` and run with `npm run dedicated:start`. Strips console.assert and other development-only code for optimal performance.
3. Client code: Build with `npm run build:production` and serve the output in `dist/browser/` to the browser.

### Testing

Tests use `tsx` (esbuild-based) as the Node.js loader, ensuring the same TypeScript compilation behavior as the Vite builds. Run with `npm test`.

### Keep the Dockerfile in sync

The `Dockerfile`'s `test` stage only has access to files it explicitly `COPY`s (plus what `.dockerignore` allows through) — it does not run `npm test` against the full working tree. Whenever you add or move test fixtures (new `data/` subdirectories, new map/texture/pak assets referenced via `import.meta.url` or `readFileSync` in a `.test.mjs` file), add a matching `COPY` line to the `test` stage, and check `.dockerignore` doesn't silently exclude the new path. The same applies to the build stages: any new top-level source file, config file, or directory required by `npm run build:production` / `npm run dedicated:build:production` must be added to the `builder` stage's `COPY` list. Treat the Dockerfile as part of the change whenever it would otherwise drift from what `npm test` or the build scripts actually need.

## Build and Deployment

All code goes through esbuild (via Vite) before it runs, so TypeScript features (decorators, `const enum`) work the same in every environment. Vite, esbuild and the `tsx` test loader strip types without checking them: `npm run typecheck` (`tsc -p tsconfig.json`, engine, games and `source/shared/`, plus the engine's tests) is the only step that catches a type error. `npm run check` runs it together with the linter.

- **Dedicated development server**: `npm run dedicated:dev` (Vite watch, source maps, output in `dist/dedicated/`), run with `npm run dedicated:start`.
- **Dedicated production server**: `npm run dedicated:build:production` (strips `console.assert` and other development-only code), run with `npm run dedicated:start`.
- **Browser client**: `npm run build:production`, output in `dist/browser/`.
- **Cloudflare** builds and deploys automatically with `npm run build:wrangler`: `typecheck`, then `npm test`, then `build:production`. A type error or a failing test fails the deploy.
- **The Dockerfile's `test` and `builder` stages see only what they `COPY`.** A new test fixture, or a new top-level source or config file the build or the type check needs, must be added there, and `.dockerignore` must not exclude it. See the `dockerfile-fixture-sync` skill.

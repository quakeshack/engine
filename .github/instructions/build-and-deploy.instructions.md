## Build and Deployment

Everything runs through esbuild (Vite), so decorators and `const enum` work everywhere. Vite, esbuild and the `tsx` test loader strip types without checking them: `npm run typecheck` (engine, games, `source/shared/`, tests) is the only type check; `npm run check` runs it with the linter.

- `dedicated:dev` builds with source maps into `dist/dedicated/`; `dedicated:build:production` strips `console.assert` and other development-only code.
- Cloudflare deploys with `npm run build:wrangler`: `typecheck`, `npm test`, `build:production`. A type error or failing test fails the deploy.
- The Dockerfile's `test` and `builder` stages see only what they `COPY` (`dockerfile-fixture-sync`).

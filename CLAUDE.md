# QuakeShack Engine

QuakeShack is a modern JavaScript/TypeScript port of the Quake 1 engine running in the browser (WebGL/WebAudio) and on Node.js, integrated with Cloudflare services.

Be a good boy scout: whenever touching something, leave it cleaner than before. Follow the conventions below. Run `eslint --fix`. Write unit tests for things you work on. Keep all existing tests passing. Update JSDoc when changing public APIs.

## Quick Reference

**Build & run**
```bash
npm install
npm run build:production          # browser client → dist/browser/
npm run dedicated:dev             # dedicated server (watch)
npm run dedicated:build:production
npm run dedicated:start
npm test                          # all tests
npm run test:game                 # game/mod tests
npm run test:common               # engine common tests
npm run test:physics
npm run test:renderer
npx eslint --fix <file>
```

**Lint before committing.** The ESLint config is strict — fix all warnings.

## Miscellaneous

- Use American English.

## Imported Guidelines

@.github/instructions/source-directories.instructions.md

@.github/instructions/architecture.instructions.md

@.github/instructions/build-and-deploy.instructions.md

@.github/instructions/code-style-guide.instructions.md

@.github/instructions/typescript-port.instructions.md

@.github/instructions/game-logic-port.instructions.md

@.github/instructions/event-bus.instructions.md

@.github/instructions/workers.instructions.md

@.github/instructions/shaders.instructions.md

@.github/instructions/unit-tests.instructions.md

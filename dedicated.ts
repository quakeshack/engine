import process from 'node:process';

import type { BuildConfig } from './source/engine/build-config';
import EngineLauncher from './source/engine/main-dedicated.ts';

// make sure working directory is the directory of this script
process.chdir(new URL('./', import.meta.url).pathname);

const buildConfig: BuildConfig = {
	mode: __BUILD_MODE__,
	timestamp: __BUILD_TIMESTAMP__,
	commitHash: __BUILD_COMMIT_HASH__,
	gameDir: __BUILD_GAME_DIR__,
	baseDir: __BUILD_BASE_DIR__,
};

await EngineLauncher.Launch(buildConfig);

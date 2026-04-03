#!/usr/bin/env node --experimental-transform-types
import process from 'node:process';

import EngineLauncher from './source/engine/main-dedicated.ts';

// make sure working directory is the directory of this script
process.chdir(new URL('./', import.meta.url).pathname);

await EngineLauncher.Launch();

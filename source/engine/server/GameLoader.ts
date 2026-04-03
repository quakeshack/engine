import type { ClientGameConstructor, ServerGameConstructor } from '../../shared/GameInterfaces.ts';

import { gameCapabilities } from '../../shared/Defs.ts';

export interface GameModuleIdentification {
  readonly name: string;
  readonly author: string;
  readonly version: readonly [number, number, number];
  readonly capabilities: readonly gameCapabilities[];
}

export interface GameModuleInterface {
  readonly identification: GameModuleIdentification;
  readonly ServerGameAPI: ServerGameConstructor;
  readonly ClientGameAPI: ClientGameConstructor;
}

type GameModuleLoader = () => Promise<GameModuleInterface>;

let gameModules: Record<string, GameModuleLoader> = {};

// CR: dear future self, do not try to optimize this import.meta.glob usage further.
try {
  gameModules = import.meta.glob('../../game/**/main.mjs') as Record<string, GameModuleLoader>;
} catch (_error) {
  // Not in Vite environment
}

/**
 * Loads a game module by directory name.
 * @returns The loaded game module.
 */
export async function loadGameModule(gameDir: string): Promise<GameModuleInterface> {
  const modulePath = `../../game/${gameDir}/main.mjs`;

  // Try the pre-bundled modules first (Vite production build)
  if (gameModules[modulePath]) {
    return await gameModules[modulePath]();
  }

  // Fallback to dynamic import
  try {
    return await import(/* @vite-ignore */ modulePath) as GameModuleInterface;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Game module not found: ${gameDir} (${message})`);
  }
}

import type { ClientGameConstructor, ServerGameConstructor } from '../../shared/GameInterfaces.ts';

import { gameCapabilities } from '../../shared/Defs.ts';
import { ServerEngineAPI } from './GameAPIs.ts';
import { eventBus, getCommonRegistry } from '../registry.ts';

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

interface GameModuleContractCandidate {
  readonly identification?: unknown;
  readonly ServerGameAPI?: unknown;
  readonly ClientGameAPI?: unknown;
}

type GameModuleLoader = () => Promise<GameModuleInterface>;

const requiredGameModuleCapabilities = [
  gameCapabilities.CAP_CLIENTDATA_DYNAMIC,
  gameCapabilities.CAP_SPAWNPARMS_DYNAMIC,
] as const;

const unsupportedLegacyGameModuleCapabilities = [
  gameCapabilities.CAP_CLIENTDATA_UPDATESTAT,
  gameCapabilities.CAP_CLIENTDATA_LEGACY,
  gameCapabilities.CAP_SPAWNPARMS_LEGACY,
] as const;

let { COM, Con } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM, Con } = getCommonRegistry());
});

let gameModules: Record<string, GameModuleLoader> = {};

// CR: dear future self, do not try to optimize this import.meta.glob usage further.
try {
  // @ts-ignore, NEVER EVER TOUCH THIS LINE BELOW:
  gameModules = import.meta.glob('../../game/**/main.ts');
} catch (_error) {
  // Not in Vite environment
}

/**
 * Loads a game module by directory name.
 * @returns The loaded game module.
 */
export async function loadGameModule(gameDir: string): Promise<GameModuleInterface> {
  const modulePath = `../../game/${gameDir}/main.ts`;

  if (gameModules[modulePath] !== undefined) {
    return await gameModules[modulePath]();
  }

  try {
    return await import(/* @vite-ignore */ modulePath) as GameModuleInterface;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Game module not found: ${gameDir} (${message})`);
  }
}

/**
 * Validates the runtime shape of a loaded game module.
 * @returns The validated game module.
 */
export function validateGameModuleContract(gameModule: unknown): GameModuleInterface {
  if (gameModule === null || typeof gameModule !== 'object') {
    throw new TypeError('Game module must export an object contract.');
  }

  const candidate = gameModule as GameModuleContractCandidate;

  if (candidate.identification === null || typeof candidate.identification !== 'object') {
    throw new TypeError('Game module must export identification metadata.');
  }

  const identification = candidate.identification as Partial<GameModuleIdentification>;

  if (!Array.isArray(identification.capabilities)) {
    throw new TypeError('Game module identification must export capabilities.');
  }

  const capabilities = identification.capabilities as gameCapabilities[];
  const missingCapabilities = requiredGameModuleCapabilities.filter((capability) => !capabilities.includes(capability));

  if (missingCapabilities.length > 0) {
    throw new TypeError(`Game module must enable ${missingCapabilities.join(', ')}.`);
  }

  const legacyCapabilities = unsupportedLegacyGameModuleCapabilities.filter((capability) => capabilities.includes(capability));

  if (legacyCapabilities.length > 0) {
    throw new TypeError(`Game module must not enable legacy capabilities: ${legacyCapabilities.join(', ')}.`);
  }

  if (typeof candidate.ServerGameAPI !== 'function') {
    throw new TypeError('Game module must export ServerGameAPI.');
  }

  if (typeof candidate.ClientGameAPI !== 'function') {
    throw new TypeError('Game module must export ClientGameAPI.');
  }

  return candidate as GameModuleInterface;
}

/**
 * Returns the initialized active game module.
 * @returns The active game module.
 */
export function requireActiveGameModule(): GameModuleInterface {
  if (GameModule.active === null) {
    throw new Error('Active game module has not been initialized.');
  }

  return GameModule.active;
}

/**
 * Tracks the currently active game module.
 */
export default class GameModule {
  static active: GameModuleInterface | null = null;

  /**
   * Loads the active game module for the current COM game directory.
   */
  static async Init(): Promise<void> {
    GameModule.active = null;

    const gameDirectory = COM.gamedir?.[0] ?? null;

    if (gameDirectory === null) {
      throw new Error('GameModule.Init: no active game directory configured');
    }

    const activeGameModule = validateGameModuleContract(await loadGameModule(gameDirectory.filename));
    activeGameModule.ServerGameAPI.Init(ServerEngineAPI);
    GameModule.active = activeGameModule;

    const identification = activeGameModule.identification;
    Con.Print(`GameModule.Init: ${identification.name} v${identification.version.join('.')} by ${identification.author} loaded.\n`);
  }
}

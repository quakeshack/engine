import { ClientGameConstructor, ServerGameConstructor } from '../../shared/GameInterfaces.ts';
import { gameCapabilities } from '../../shared/Defs.ts';

export interface GameModuleIdentification {
  name: string;
  author: string;
  version: [number, number, number];
  capabilities: gameCapabilities[];
}

export interface GameModuleInterface {
  identification: GameModuleIdentification,
  ServerGameAPI: ServerGameConstructor;
  ClientGameAPI: ClientGameConstructor;
};

export async function loadGameModule(gameDir: string): Promise<GameModuleInterface>;


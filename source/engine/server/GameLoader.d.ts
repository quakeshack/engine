import { ClientGameInterface, ServerGameInterface } from "../../shared/GameInterfaces";
import { gameCapabilities } from "../../shared/Defs.ts";

export interface GameModuleIdentification {
  name: string;
  author: string;
  version: [number, number, number];
  capabilities: gameCapabilities[];
}

export interface GameModuleInterface {
  identification: GameModuleIdentification,
  ServerGameAPI: ServerGameInterface;
  ClientGameAPI: ClientGameInterface;
};

export async function loadGameModule(gameDir: string): Promise<GameModuleInterface>;


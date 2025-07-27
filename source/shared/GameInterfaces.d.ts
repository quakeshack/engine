import { BaseClientEdictHandler } from "./ClientEdict.mjs";
import { ClientEngineAPI, ServerEngineAPI } from "../engine/common/GameAPIs.mjs";
import { ServerEdict } from "../engine/server/Edict.mjs";

export type ClientEventArgument = (string | number | boolean | Vector);

export interface ClientGameInterface {
  init(): void;
  shutdown(): void;
  draw(): void;

  handleClientEvent(code: number, ...args: ClientEventArgument[]): void;

  static GetClientEdictHandler(classname: string): BaseClientEdictHandler

  static Init(engineAPI: ClientEngineAPI): void;
  static Shutdown(): void;

  static IsServerCompatible(version: number[]): boolean;
};

export interface ServerGameInterface {
  StartFrame(): void;
  SetNewParms(): void;
  SetSpawnParms(clientEntity: ServerEdict): void;
  SetChangeParms(clientEdict: ServerEdict): void;
  PlayerPreThink(clientEdict: ServerEdict): void;
  PlayerPostThink(clientEdict: ServerEdict): void;
  ClientConnect(clientEdict: ServerEdict): void;
  ClientDisconnect(clientEdict: ServerEdict): void;
  ClientKill(clientEdict: ServerEdict): void;
  PutClientInServer(clientEdict: ServerEdict): void;

  init(mapname: string, serverflags: number): void;
  shutdown(isCrashShutdown: boolean): void;
  prepareEntity(edict: ServerEdict, classname: string, initialData?: any): boolean;
  spawnPreparedEntity(edict: ServerEdict): boolean;

  serialize(): any;
  deserialize(data: any): void;

  static Init(ServerEngineAPI: ServerEngineAPI): void;
  static Shutdown(): void;
};


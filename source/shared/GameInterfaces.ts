import type { BaseClientEdictHandler } from './ClientEdict.ts';
import type { ClientEngineAPI as ClientEngineApiValue, ServerEngineAPI as ServerEngineApiValue } from '../engine/common/GameAPIs.mjs';
import type { ServerEdict as ServerEdictValue } from '../engine/server/Edict.mjs';
import type { GLTexture as GLTextureValue } from '../engine/client/GL.mjs';
import type { SFX as SFXValue } from '../engine/client/Sound.mjs';
import type CvarValue from '../engine/common/Cvar.ts';
import type Vector from './Vector.ts';
import type { PmoveConfiguration as PmoveConfigurationValue, PmoveQuake2Configuration as PmoveQuake2ConfigurationValue } from '../shared/Pmove.ts';
import type { StartGameInterface } from '../engine/client/ClientLifecycle.mjs';
import type { BaseModel } from '../engine/common/model/BaseModel.ts';

export type ClientEngineAPI = Readonly<typeof ClientEngineApiValue>;
export type ServerEngineAPI = Readonly<typeof ServerEngineApiValue>;
export type ServerEdict = Readonly<ServerEdictValue>;

export type GLTexture = GLTextureValue;
export type Cvar = Readonly<CvarValue>;

export type PmoveConfiguration = Readonly<PmoveConfigurationValue>;
export type PmoveQuake2Configuration = Readonly<PmoveQuake2ConfigurationValue>;

export type SerializableType = string | number | boolean | Vector | ServerEdict | SerializableType[] | null;

export type ClientdataMap = Record<string, SerializableType>;

export type EdictValueType = string | number | boolean | Vector | null;
export type EdictData = Record<string, EdictValueType>;

export type SFX = Readonly<SFXValue>;

export type ViewmodelConfig = {
  visible: boolean;
  model: BaseModel;
  frame: number;
};

export type ViewportDimensions = {
  width: number;
  height: number;
};

export type RefDef = {
  vrect: ViewportDimensions;
  vieworg: Vector;
  viewangles: Vector;
};

export interface ParsedQC {
  cd: string;
  origin: Vector;
  base: string | null;
  skin: string | null;
  frames: string[];
  animations: Record<string, number[]>;
  scale: number;
}

export type ViewportResizeEvent = ViewportDimensions;

export type ClientDamageEvent = {
  damageReceived: number;
  armorLost: number;
  attackOrigin: Vector;
};

export declare abstract class ClientGameInterface {
  clientdata: ClientdataMap | null;
  viewmodel: ViewmodelConfig | null;

  init(): void;
  shutdown(): void;

  startFrame(): void;
  draw(): void;
  drawLoading(): void;

  saveGame(): string;
  loadGame(data: string): void;

  handleClientEvent(code: number, ...args: SerializableType[]): void;
  updateRefDef(refdef: RefDef): void;

  static GetStartGameInterface(engineAPI: ClientEngineAPI): StartGameInterface | null;
  static GetClientEdictHandler(classname: string): typeof BaseClientEdictHandler | null;
  static Init(engineAPI: ClientEngineAPI): void;
  static Shutdown(): void;
  static IsServerCompatible(version: number[]): boolean;
}

export type ClientGameConstructor = typeof ClientGameInterface;

export interface PlayerEntitySpawnParamsDynamic {
  saveSpawnParameters(): string;
  restoreSpawnParameters(data: string): void;
}

export interface ServerInfoField {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'maplist' | 'enum';
  enumValues?: Record<string, string | number>;
}

export interface MapDetails {
  name: string;
  label: string;
  maxplayers: number;
  pictures: string[];
}

export interface StartServerListEntry {
  label: string;
  callback: (serverEngineAPI: ServerEngineAPI) => void;
}

export type SerializedPrimitive = string | number | boolean | null;
export type SerializedVector = [number, number, number, number];
export type SerializedSkipped = [number];
export type SerializedInfinity = [number, number];
export type SerializedPrimitiveValue = [number, SerializedPrimitive];
export type SerializedFunction = [number, string];
export type SerializedArray = [number, SerializedValue[]];
export type SerializedEdictReference = [number, number];
export type SerializedObject = [number, SerializedData];
export type SerializedValue = SerializedSkipped | SerializedInfinity | SerializedPrimitiveValue | SerializedFunction | SerializedVector | SerializedArray | SerializedEdictReference | SerializedObject;
export type SerializedData = Record<string, SerializedValue>;

export declare abstract class ServerGameInterface {
  SetNewParms?(): void;
  SetSpawnParms?(clientEdict: ServerEdict): void;
  SetChangeParms?(clientEdict: ServerEdict): void;

  PlayerPreThink(clientEdict: ServerEdict): void;
  PlayerPostThink(clientEdict: ServerEdict): void;

  ClientConnect(clientEdict: ServerEdict): void;
  ClientDisconnect(clientEdict: ServerEdict): void;
  ClientKill(clientEdict: ServerEdict): void;

  PutClientInServer(clientEdict: ServerEdict): void;

  ClientBegin?(clientEdict: ServerEdict): void;

  init(mapname: string, serverflags: number): void;
  shutdown(isCrashShutdown: boolean): void;
  startFrame(): void;

  getClientEntityFields(): Record<string, string[]>;

  prepareEntity(edict: ServerEdict, classname: string, initialData?: EdictData): boolean;
  spawnPreparedEntity(edict: ServerEdict): boolean;

  serialize(): SerializedData;
  deserialize(data: SerializedData): void;

  static GetServerInfoFields(): ServerInfoField[];
  static GetMapList(): MapDetails[] | null;
  static GetStartServerList(): StartServerListEntry[] | null;
  static Init(serverEngineAPI: ServerEngineAPI): void;
  static Shutdown(): void;
}

export type ServerGameConstructor = typeof ServerGameInterface;

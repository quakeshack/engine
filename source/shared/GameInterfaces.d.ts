import { BaseClientEdictHandler } from "./ClientEdict.mjs";
import { ClientEngineAPI, ServerEngineAPI } from "../engine/common/GameAPIs.mjs";
import { ServerEdict } from "../engine/server/Edict.mjs";
import Vector from "./Vector.mjs";
import { StartGameInterface } from "../engine/client/ClientLifecycle.mjs";

export type ClientEngineAPI = Readonly<typeof ClientEngineAPI>;
export type ServerEngineAPI = Readonly<typeof ServerEngineAPI>;
export type ServerEdict = Readonly<ServerEdict>;

//export type GLTexture = Readonly<import("../engine/client/GL.mjs").GLTexture>;
export type GLTexture = import("../engine/client/GL.mjs").GLTexture;
export type Cvar = Readonly<import("../engine/common/Cvar.mjs").default>;

export type PmoveConfiguration = Readonly<import("../shared/Pmove.mjs").PmoveConfiguration>;
export type PmoveQuake2Configuration = Readonly<import("../shared/Pmove.mjs").PmoveQuake2Configuration>;

export type SerializableType = (string | number | boolean | Vector | ServerEdict | SerializableType[] | null);

export type ClientdataMap = Record<string, SerializableType>;

export type EdictValueType = (string | number | boolean | Vector | null);
export type EdictData = Record<string, EdictValueType>;

export type SFX = Readonly<import("../engine/client/Sound.mjs").SFX>;

export type ViewmodelConfig = {
  visible: boolean;
  model: BaseModel;
  frame: number;
};

export type ViewportDimensions = {
  width: number;
  height: number;
};

export type RefDef = { // TODO: move to engine shared, it’s V’s refdef
  vrect: ViewportDimensions;
  vieworg: Vector;
  viewangles: Vector;
  // TODO: fov?
};

export interface ParsedQC {
  cd: string;
  origin: Vector;
  base: string | null;
  skin: string | null;
  frames: string[];
  animations: Record<string, number[]>;
  scale: number;
};

export type ViewportResizeEvent = ViewportDimensions;

export type ClientDamageEvent = {
  damageReceived: number,
  armorLost: number,
  attackOrigin: Vector,
};

export interface ClientGameInterface {
  clientdata: ClientdataMap | null;
  viewmodel: ViewmodelConfig | null;

  // client initialization and shutdown methods
  init(): void;
  shutdown(): void;

  // client main loop methods
  startFrame(): void;
  draw(): void;
  drawLoading(): void;

  // serialization methods (for saving/loading games)
  saveGame(): string;
  loadGame(data: string);

  // client event handling methods and state change hooks
  handleClientEvent(code: number, ...args: SerializableType[]): void;
  updateRefDef(refdef: RefDef): void;

  // optional interface for menu integration (NOTE: object to change)
  static GetStartGameInterface(engineAPI: ClientEngineAPI): StartGameInterface | null;

  // client edict handler retrieval
  static GetClientEdictHandler(classname: string): typeof BaseClientEdictHandler | null;

  // lifecycle methods
  static Init(engineAPI: ClientEngineAPI): void;
  static Shutdown(): void;

  static IsServerCompatible(version: number[]): boolean;
};

export interface PlayerEntitySpawnParamsDynamic {
  saveSpawnParameters(): string;
  restoreSpawnParameters(data: string): void;
};

export interface ServerInfoField {
  name: string;
  label: string;
  type: "string" | "number" | "boolean" | "maplist" | "enum";
  enumValues?: Record<string, string | number>;
};

export interface MapDetails {
  name: string;
  label: string;
  maxplayers: number;
  pictures: string[];
};

export interface StartServerListEntry {
  label: string;
  callback: (ServerEngineAPI: ServerEngineAPI) => void;
};

export interface ServerGameInterface {
  // only used with CAP_SPAWNPARMS_LEGACY flag
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

  serialize(): any;
  deserialize(data: any): void;

  static GetServerInfoFields(): ServerInfoField[];
  static GetMapList(): MapDetails[] | null;
  static GetStartServerList(): StartServerListEntry[] | null;

  static Init(ServerEngineAPI: ServerEngineAPI): void;
  static Shutdown(): void;
};


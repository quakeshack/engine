import type { BaseClientEdictHandler } from './ClientEdict.ts';
import type { ClientEngineAPI as ClientEngineApiValue, ServerEngineAPI as ServerEngineApiValue } from '../engine/common/GameAPIs.ts';
import type { ClientEdict as ClientEdictValue } from '../engine/client/ClientEntities.ts';
import type { ServerEdict as ServerEdictValue } from '../engine/server/Edict.ts';
import type { GLTexture as GLTextureValue } from '../engine/client/GL.ts';
import type { MenuItem as MenuItemValue } from '../engine/client/menu/MenuItem.ts';
import type { MenuPage as MenuPageValue } from '../engine/client/menu/MenuPage.ts';
import type { SFX as SFXValue } from '../engine/client/Sound.ts';
import type CvarValue from '../engine/common/Cvar.ts';
import type Vector from './Vector.ts';
import type { PmoveConfiguration as PmoveConfigurationValue, PmoveQuake2Configuration as PmoveQuake2ConfigurationValue } from '../shared/Pmove.ts';
import type { BaseModel } from '../engine/common/model/BaseModel.ts';
import type { StartGameInterface } from '../engine/client/ClientLifecycle.ts';

export type { StartGameInterface } from '../engine/client/ClientLifecycle.ts';

export type ClientEngineAPI = Readonly<typeof ClientEngineApiValue>;
export type ServerEngineAPI = Readonly<typeof ServerEngineApiValue>;
export type ClientEdict = Readonly<ClientEdictValue>;
export type ServerEdict = Readonly<ServerEdictValue>;

export type GLTexture = GLTextureValue;
export type Cvar = Readonly<CvarValue>;

// Menu widgets are mutable-by-design (game code configures labels/items directly), so these
// are plain aliases rather than Readonly wrappers.
export type MenuPage = MenuPageValue;
export type MenuItem = MenuItemValue;

export type PmoveConfiguration = Readonly<PmoveConfigurationValue>;
export type PmoveQuake2Configuration = Readonly<PmoveQuake2ConfigurationValue>;

export interface SerializableObject {
  [key: string]: SerializableType;
}
export type SerializableType = string | number | boolean | Vector | ServerEdict | SerializableObject | SerializableType[] | null;
export type ClientSerializableType = string | number | boolean | Vector | ClientEdict | ClientSerializableType[] | null;
export type ClientEventValue = ClientSerializableType | object;

export type ClientdataMap = Record<string, ClientSerializableType>;

export interface ServerEntityReference {
  readonly edict?: ServerEdict | null;
  readonly edictId?: number | null;
}

export type EdictValueType = string | number | boolean | Vector | ServerEdict | ServerEntityReference | null;
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

export type HostAlertSeverity = 'info' | 'error';

/**
 * Payload for the `host.alert` event, published by `Host.EndGame`/`Host.Error` instead of
 * calling into the menu system directly -- game code decides independently whether/how to
 * present it (see docs/events.md#host).
 */
export interface HostAlertEvent {
  readonly title: string;
  readonly message: string;
  readonly severity: HostAlertSeverity;
}

export type PostProcessColorGradeDescriptor = {
  readonly saturation?: number;
  readonly contrast?: number;
  readonly exposure?: number;
  readonly tintColor?: Vector;
  readonly tintStrength?: number;
  readonly pulseStrength?: number;
  readonly pulsePeriod?: number;
};

export type PostProcessBlurDescriptor = {
  readonly radius?: number;
};

export type PostProcessEffectDescriptor =
  | { readonly id: 'color-grade'; readonly settings: PostProcessColorGradeDescriptor }
  | { readonly id: 'blur'; readonly settings: PostProcessBlurDescriptor };

export type PostProcessStack = readonly PostProcessEffectDescriptor[];

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

  handleClientEvent(code: number, ...args: ClientEventValue[]): void;
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
export type SerializedSkipped = ['X'];
export type SerializedInfinity = ['I', number];
export type SerializedPrimitiveValue = ['P', SerializedPrimitive];
export type SerializedFunction = ['F', string];
export type SerializedArray = ['A', SerializedValue[]];
export type SerializedEdictReference = ['E', number | null];
export type SerializedObject = ['S', SerializedData];
export type SerializedVector = ['V', ...number[]];
export type SerializedValue = SerializedSkipped | SerializedInfinity | SerializedPrimitiveValue | SerializedFunction | SerializedArray | SerializedEdictReference | SerializedObject | SerializedVector;
export type SerializedData = Record<string, SerializedValue>;

interface SerializableEntityCandidate {
  readonly classname?: unknown;
  readonly serialize?: unknown;
  readonly deserialize?: unknown;
}

export abstract class SerializableEntity {
  static [Symbol.hasInstance](value: unknown): boolean {
    if (value === null || typeof value !== 'object') {
      return false;
    }

    const candidate = value as SerializableEntityCandidate;

    return typeof candidate.classname === 'string'
      && typeof candidate.serialize === 'function'
      && typeof candidate.deserialize === 'function';
  }

  abstract classname: string;
  abstract serialize(): SerializedData;
  abstract deserialize(data: SerializedData): void;
}

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

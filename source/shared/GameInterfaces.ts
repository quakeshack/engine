import type { BaseClientEdictHandler } from './ClientEdict.ts';
import type { ClientEngineAPI as ClientEngineApiValue, CommonEngineAPI as CommonEngineApiValue, ServerEngineAPI as ServerEngineApiValue } from '../engine/common/GameAPIs.ts';
import type { ClientEdict as ClientEdictValue } from '../engine/client/ClientEntities.ts';
import type { ServerEdict as ServerEdictValue } from '../engine/server/Edict.ts';
import type { BitmapFont as BitmapFontValue } from '../engine/client/BitmapFont.ts';
import type { GLTexture as GLTextureValue } from '../engine/client/GL.ts';
import type { Action as ActionValue, ColorPicker as ColorPickerValue, KeyBindItem as KeyBindItemValue, MenuItem as MenuItemValue, SaveSlotItem as SaveSlotItemValue, Textbox as TextboxValue } from '../engine/client/menu/MenuItem.ts';
import type { DialogPage as DialogPageValue, ListPage as ListPageValue, MenuPage as MenuPageValue } from '../engine/client/menu/MenuPage.ts';
import type { BackButtonAnchor as BackButtonAnchorValue } from '../engine/client/menu/MenuPage.ts';
import type { MenuViewport as MenuViewportValue, MenuViewportCorner as MenuViewportCornerValue } from '../engine/client/menu/MenuViewport.ts';
import type { MenuPic as MenuPicValue } from '../engine/client/Menu.ts';
import type { SFX as SFXValue } from '../engine/client/Sound.ts';
import type CvarValue from '../engine/common/Cvar.ts';
import type Vector from './Vector.ts';
import type { gameCapabilities } from './Defs.ts';
import type { PmoveConfiguration as PmoveConfigurationValue, PmoveQuake2Configuration as PmoveQuake2ConfigurationValue } from '../shared/Pmove.ts';
import type { BaseModel } from '../engine/common/model/BaseModel.ts';
import type { StartGameInterface } from '../engine/client/ClientLifecycle.ts';
import type { DiscoveredSession as DiscoveredSessionValue, SessionDiscoveryStatus as SessionDiscoveryStatusValue } from '../engine/client/menu/SessionDiscovery.ts';

export type { StartGameInterface } from '../engine/client/ClientLifecycle.ts';

export type DiscoveredSession = DiscoveredSessionValue;
export type SessionDiscoveryStatus = SessionDiscoveryStatusValue;

export type ClientEngineAPI = Readonly<typeof ClientEngineApiValue>;
export type ServerEngineAPI = Readonly<typeof ServerEngineApiValue>;
export type CommonEngineAPI = Readonly<typeof CommonEngineApiValue>;
export type ClientEdict = Readonly<ClientEdictValue>;
export type ServerEdict = Readonly<ServerEdictValue>;

export type GLTexture = GLTextureValue;
export type BitmapFont = BitmapFontValue;
export type Cvar = Readonly<CvarValue>;

// Menu widgets are mutable-by-design (game code configures labels/items directly), so these
// are plain aliases rather than Readonly wrappers.
export type MenuPage = MenuPageValue;
export type DialogPage = DialogPageValue;
export type ListPage = ListPageValue;
export type MenuItem = MenuItemValue;
export type Action = ActionValue;
export type Textbox = TextboxValue;
export type ColorPicker = ColorPickerValue;
export type SaveSlotItem = SaveSlotItemValue;
export type KeyBindItem = KeyBindItemValue;
export type MenuPic = MenuPicValue;
export type BackButtonAnchor = BackButtonAnchorValue;
export type MenuViewport = MenuViewportValue;
export type MenuViewportCorner = MenuViewportCornerValue;

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

/**
 * What the engine draws as the first-person weapon model. The engine only reads it.
 */
export interface ViewmodelConfig {
  readonly visible: boolean;

  /** The model to draw. `null` while the game has none, in which case nothing is drawn. */
  readonly model: BaseModel | null;

  readonly frame: number;
}

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

/**
 * Everything the engine calls, reads, or writes on a running client-side game instance.
 *
 * The engine constructs a new instance through `ClientGameConstructor` every time the server
 * announces a map (when connecting and on every changelevel) and calls `shutdown` when the client
 * disconnects. A changelevel replaces the instance without calling `shutdown` on the old one. A
 * game's client API class declares `implements ClientGameInterface` and its `main.ts` asserts
 * `satisfies GameModuleInterface`, so a change on either side of this boundary is a compile error
 * instead of a runtime surprise. Members that are not listed here are internal to the game.
 */
export interface ClientGameInterface {
  /**
   * The player's replicated state. The engine writes the values the server sends straight into
   * this object and raises an error if it is `null` when such an update arrives, so a game sets
   * it up in its constructor.
   */
  readonly clientdata: ClientdataMap | null;

  /**
   * The first-person weapon model to draw. The engine only reads it; `null` draws nothing.
   */
  readonly viewmodel: ViewmodelConfig | null;

  /**
   * Called once per map, after the map's models and sounds finished loading and the renderer was
   * prepared for it (when connecting and after every changelevel). When a savegame is being
   * restored, `loadGame` follows.
   */
  init(): void;

  /**
   * Called when the client disconnects from the server, right before the engine drops its
   * reference to this instance. Not called on a changelevel: the engine replaces the instance with
   * a new one.
   */
  shutdown(): void;

  /**
   * Called once per client frame after the connection is fully established, before the client
   * entities think.
   */
  startFrame(): void;

  /**
   * Called every frame the HUD is drawn. Skipped while the `nohud` cvar is set.
   */
  draw(): void;

  /**
   * Called every frame while the client is connecting or changing level, right after the engine
   * cleared the screen to black.
   */
  drawLoading(): void;

  /**
   * Called when a savegame is written. The returned string is stored next to the server state.
   */
  saveGame(): string;

  /**
   * Restores what `saveGame` produced. Called right after `init` when a savegame is being restored.
   */
  loadGame(data: string): void;

  /**
   * Called for every client event the server sends to this player.
   * @param code The event code, as defined by the game.
   */
  handleClientEvent(code: number, ...args: ClientEventValue[]): void;

  /**
   * Called each frame after the engine calculated the view, so the game can adjust it before it is
   * rendered.
   */
  updateRefDef(refdef: RefDef): void;
}

/**
 * The static side of a game's client API class: how the engine creates and initializes it.
 */
export interface ClientGameConstructor {
  /**
   * Creates the game instance for one map of a server connection. The engine calls it while
   * handling the server's serverdata message (when connecting and on every changelevel), after
   * `IsServerCompatible` accepted the server.
   */
  new (engineAPI: ClientEngineAPI): ClientGameInterface;

  /**
   * One-time module initialization, called once when the game module is loaded on the client
   * (e.g. to register menu pages).
   */
  Init(engineAPI: ClientEngineAPI): void;

  /**
   * Counterpart of `Init`. Reserved: the engine has no module-unload path yet and does not call it.
   */
  Shutdown(engineAPI: ClientEngineAPI): void;

  /**
   * Lets the game replace the engine's default way of starting a game. Called once, right after
   * `Init`.
   * @returns The game's start behavior, or `null` to keep the engine default.
   */
  GetStartGameInterface(engineAPI: ClientEngineAPI): StartGameInterface | null;

  /**
   * Called when a client entity is assigned a classname, to let the game attach client-side
   * behavior to it.
   * @returns The handler class for that classname, or `null` when the game has none.
   */
  GetClientEdictHandler(classname: string): typeof BaseClientEdictHandler | null;

  /**
   * Decides whether this client can play on a server running the given game version. Called before
   * the game instance is created.
   * @param version The server's game version as [major, minor, patch].
   */
  IsServerCompatible(version: number[]): boolean;
}

export interface PlayerEntitySpawnParamsDynamic {
  saveSpawnParameters(): string;
  restoreSpawnParameters(data: string): void;
}

/**
 * Describes one server setting. Game-side helper shape: games return it from their own static
 * helpers, the engine does not call them.
 */
export interface ServerInfoField {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'maplist' | 'enum';
  enumValues?: Record<string, string | number>;
}

/**
 * Describes one map a game offers. Game-side helper shape: games return it from their own static
 * helpers, the engine does not call them.
 */
export interface MapDetails {
  name: string;
  label: string;
  maxplayers: number;
  pictures: string[];
}

/**
 * Describes one entry of a game's "start a server" menu. Game-side helper shape: games return it
 * from their own static helpers, the engine does not call them.
 */
export interface StartServerListEntry {
  label: string;
  callback: (engineAPI: CommonEngineAPI) => void;
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

/**
 * Everything the engine calls, reads, or writes on a running server-side game instance.
 *
 * The engine constructs one instance per map load through `ServerGameConstructor`. A game's server
 * API class declares `implements ServerGameInterface` and its `main.ts` asserts
 * `satisfies GameModuleInterface`, so a change on either side of this boundary is a compile error
 * instead of a runtime surprise. Members that are not listed here are internal to the game.
 */
export interface ServerGameInterface {
  /**
   * Server time in seconds. The engine writes it right before every call into the game: the
   * current server time for touches and player callbacks, and the scheduled time when an entity's
   * think runs (between the current server time and the end of the current frame). Game code
   * should treat it as read-only.
   */
  time: number;

  /**
   * Duration of the current server frame in seconds. The engine writes it once per frame.
   */
  frametime: number;

  /**
   * While non-zero, the engine re-links every entity each frame so stationary triggers re-check
   * their contacts (e.g. telefrag triggers). The game sets it (typically to 2), the engine
   * decrements it once per frame.
   */
  force_retouch: number;

  /**
   * Game-defined bit field of progress that survives level changes (the classic Quake use is the
   * collected episode runes). The engine passes it to `init` on every map load and reads it back
   * at changelevel to carry it into the next map. The game owns and mutates it.
   */
  readonly serverflags: number;

  /**
   * Called once per map load, after the engine prepared the player entities and client fields and
   * before the worldspawn entity is spawned.
   * @param mapname The map being loaded.
   * @param serverflags The value carried over from the previous map.
   */
  init(mapname: string, serverflags: number): void;

  /**
   * Called when the server shuts down (quitting, the `map` command, leaving a listen server, a
   * failed map load, ...), right before the engine drops its reference to this instance. A
   * changelevel does not call it: the engine replaces the instance with a new one for the next map.
   * @param isCrashShutdown True for an emergency shutdown, in which case the engine also skips
   *   `ClientDisconnect` for the connected clients. No engine path raises it today.
   */
  shutdown(isCrashShutdown: boolean): void;

  /**
   * Called at the start of every simulated server frame, after `time` was written and before any
   * entity is processed.
   */
  startFrame(): void;

  /**
   * Called before the engine runs the movement physics of a connected client.
   */
  PlayerPreThink(clientEdict: ServerEdict): void;

  /**
   * Called after the engine ran the movement physics and touch handling of a connected client.
   */
  PlayerPostThink(clientEdict: ServerEdict): void;

  /**
   * Called when a client spawns into a freshly started map, right before `PutClientInServer`.
   * Not called while a savegame is being restored.
   */
  ClientConnect(clientEdict: ServerEdict): void;

  /**
   * Called when a spawned client is removed while the engine can still talk to it: it
   * disconnected, was kicked, or the server shut down. Not called for a client the engine drops
   * because its connection failed, nor for a client that never finished spawning.
   */
  ClientDisconnect(clientEdict: ServerEdict): void;

  /**
   * Called when a client issues the `kill` command.
   */
  ClientKill(clientEdict: ServerEdict): void;

  /**
   * Called right after `ClientConnect` to place the player into the world. Not called while a
   * savegame is being restored.
   */
  PutClientInServer(clientEdict: ServerEdict): void;

  /**
   * Optional. Called when a client finished loading and enters the game (the `begin` command).
   */
  ClientBegin?(clientEdict: ServerEdict): void;

  /**
   * Maps an entity classname to the field names the engine replicates to clients for that class.
   */
  getClientEntityFields(): Record<string, string[]>;

  /**
   * First half of entity creation: attaches a game entity of the given class to the edict and
   * applies the initial data.
   * @returns False when the class is unknown or must not exist in the current game mode.
   */
  prepareEntity(edict: ServerEdict, classname: string, initialData?: EdictData): boolean;

  /**
   * Second half of entity creation: runs the spawn logic of an entity set up by `prepareEntity`.
   */
  spawnPreparedEntity(edict: ServerEdict): boolean;

  /**
   * Game-wide state stored in a savegame next to the entities.
   */
  serialize(): SerializedData;

  /**
   * Restores what `serialize` produced.
   */
  deserialize(data: SerializedData): void;
}

/**
 * The static side of a game's server API class: how the engine creates and initializes it.
 */
export interface ServerGameConstructor {
  /**
   * Creates the game instance for one map load (spawning a server or changing level).
   */
  new (engineAPI: ServerEngineAPI): ServerGameInterface;

  /**
   * One-time module initialization, called once when the game module is loaded (e.g. to register cvars).
   */
  Init(serverEngineAPI: ServerEngineAPI): void;

  /**
   * Counterpart of `Init`. Reserved: the engine has no module-unload path yet and does not call it.
   */
  Shutdown(): void;
}

/**
 * Identification metadata a game module exports for logging, version checks and capability negotiation.
 */
export interface GameModuleIdentification {
  readonly name: string;
  readonly author: string;
  readonly version: readonly [number, number, number];
  readonly capabilities: readonly gameCapabilities[];
}

/**
 * The shape of a game module's `main.ts`, as the engine loads it. A game asserts
 * `satisfies GameModuleInterface` on its exports to have the compiler check it against the engine.
 */
export interface GameModuleInterface {
  readonly identification: GameModuleIdentification;
  readonly ServerGameAPI: ServerGameConstructor;
  readonly ClientGameAPI: ClientGameConstructor;
}

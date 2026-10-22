import type { ClientDamageEvent, ClientSerializableType, HostAlertEvent } from './GameInterfaces.ts';
import type CvarValue from '../engine/common/Cvar.ts';
import type { QSocket } from '../engine/network/NetworkDrivers.ts';
import type { URLs } from '../engine/build-config';
import type { SearchPath } from '../engine/common/Com.ts';
import type Vector from './Vector.ts';

/** A position as the navigation events carry it: the server's vector, or what is left of it after crossing the worker boundary. */
export type EventPosition = Vector | readonly [number, number, number];

/** What the navigation worker answers a path request with: the points of the path, or `null` when there is none. */
export type EventPath = EventPosition[] | null;

/** The first argument of `worker.framework.init`: the search paths, the game directory's paths and the game name. */
export type WorkerFrameworkInitPayload = [SearchPath[], SearchPath[] | null, string];

/** The first argument of `vid.resize`. */
export interface ViewportResizeEvent {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
}

/** The argument of `server.spawning` and `server.spawned`. */
export interface ServerSpawnEvent {
  readonly mapname: string;
}

/** Whatever an uncaught exception or a rejection was thrown as, as `host.crash` carries it. */
export type CrashEventReason =
  | Error
  | string
  | null
  | undefined
  | {
      readonly name?: string;
      readonly message?: string;
      readonly constructor?: { readonly name?: string };
    };

/**
 * Every event the engine publishes on its realm bus: the event name and, as a labeled tuple, its arguments.
 *
 * This is the one place that says what an event looks like. `docs/events.md` documents the same names, and
 * `test/common/event-map-docs.test.ts` fails when the two drift apart. A new event is added here, to
 * {@link engineEventTable} and to the docs, in that order.
 *
 * Arguments must survive structured cloning when the event is in `crossesWorker` in the table.
 */
export interface EngineEventMap {
  // Common
  'com.argv.ready': [];
  'com.registered': [registered: boolean];
  'com.ready': [];
  'com.fs.being': [filename: string];
  'com.fs.end': [filename: string];

  // Client
  'client.paused': [];
  'client.unpaused': [];
  'client.cdtrack': [track: number];
  'client.players.name-changed': [num: number, oldName: string, newName: string];
  'client.players.frags-updated': [num: number, frags: number];
  'client.players.colors-updated': [num: number, colors: number];
  'client.server-info.ready': [serverInfo: Record<string, string>];
  'client.server-info.updated': [name: string, value: string];
  'client.damage': [event: ClientDamageEvent];
  'client.center-print': [message: string];
  'client.chat.message': [name: string, message: string, direct: boolean];
  'client.clientdata.field-changed': [field: string, value: ClientSerializableType, previousValue: ClientSerializableType];
  'client.disconnected': [];
  'client.connecting': [address: string];
  'client.connected': [address: string | null];
  'client.signon': [signon: number];
  'client.game-initialized': [];

  // Menu
  'menu.page-registered': [name: string];
  'menu.opened': [name: string | null];
  'menu.closed': [name: string | null];

  // Console
  'console.print-line': [line: string];

  // Cvars
  'cvar.registered': [name: string];
  'cvar.changed': [name: string];
  [name: `cvar.changed.${string}`]: [cvar: CvarValue];

  // Frontend
  'gl.ready': [gl: WebGL2RenderingContext];
  'gl.shutdown': [];
  'gl.texture.ready': [identifier: string];
  'renderer.shaders.initialized': [];
  'renderer.textures.initialized': [];
  'vid.resize': [size: ViewportResizeEvent];

  // Host
  'host.crash': [error: CrashEventReason];
  'host.ready': [];
  'host.shutting-down': [];
  'host.shutdown': [];
  'host.config.loaded': [];
  'host.alert': [event: HostAlertEvent];
  'host.quit-requested': [];

  // Network
  'net.connection.accepted': [socket: QSocket];
  'net.connection.close': [socket: QSocket];
  'net.connection.error': [socket: QSocket];

  // Server
  'server.spawning': [event: ServerSpawnEvent];
  'server.spawned': [event: ServerSpawnEvent];
  'server.edict.assigned': [edictNum: number];
  'server.edict.freed': [edictNum: number];
  'server.shutting-down': [];
  'server.shutdown': [];
  'server.client.connected': [num: number, name: string];
  'server.client.disconnected': [num: number, name: string];

  // Navigation
  'nav.load': [mapname: string, checksum: number | null];
  'nav.path.request': [id: string, start: EventPosition, goal: EventPosition];
  'nav.debug.emit-dot.temporarily': [position: EventPosition, color: number, ttl: number];
  'nav.debug.emit-dot.permanently': [position: EventPosition, color: number];
  'nav.path.response': [id: string, path: EventPath];
  'nav.build': [];

  // Workers
  'worker.framework.init': [payload: WorkerFrameworkInitPayload, urls: URLs | undefined];
  'worker.test': [message: string | null];
  'worker.busy': [durationMs: number | string];
  'worker.error': [];

  // WAD files
  'wad.palette.loaded': [];

  // Map dynamics
  'areaportals.changed': [];
}

/**
 * The name of an engine event as it is written in `docs/events.md`: a parameterized one has a placeholder in the
 * place of the parameter (`cvar.changed.<cvar-name>` for `cvar.changed.${string}`).
 */
export type EngineEventDocName = Exclude<keyof EngineEventMap, `cvar.changed.${string}`> | 'cvar.changed.<cvar-name>';

/** The name of an engine event a bus accepts: a literal one, or one of the parameterized families. */
export type EngineEventName = keyof EngineEventMap;

/** Which buses an event reaches, besides the realm's own. */
export interface EngineEventMeta {
  /** Whether the client game's buses (`ClientEngineAPI.eventBus` and `moduleEventBus`) receive it. */
  readonly clientGame: boolean;
  /** Whether the server game's bus (`ServerEngineAPI.eventBus`) receives it. */
  readonly serverGame: boolean;
  /** Whether the server worker forwards it to the page (and its arguments are structured-cloneable). */
  readonly crossesWorker: boolean;
}

const PAGE_ONLY = Object.freeze({ clientGame: false, serverGame: false, crossesWorker: false } as const satisfies EngineEventMeta);
const CLIENT_GAME = Object.freeze({ clientGame: true, serverGame: false, crossesWorker: false } as const satisfies EngineEventMeta);
const CROSSES_WORKER = Object.freeze({ clientGame: false, serverGame: false, crossesWorker: true } as const satisfies EngineEventMeta);
const CROSSES_WORKER_TO_CLIENT_GAME = Object.freeze({ clientGame: true, serverGame: false, crossesWorker: true } as const satisfies EngineEventMeta);
const GAME_BOTH = Object.freeze({ clientGame: true, serverGame: true, crossesWorker: false } as const satisfies EngineEventMeta);
const SERVER_GAME = Object.freeze({ clientGame: false, serverGame: true, crossesWorker: false } as const satisfies EngineEventMeta);

/**
 * Per event, what the three hand-kept lists used to say: whether a game sees it and whether it crosses the worker
 * boundary. `clientGameEvents` (`ClientState.ts`) and `forwardedServerEvents` (`ServerWorkerProtocol.ts`) are derived
 * from it. The keys are the documented names, and the compiler keeps them equal to {@link EngineEventMap}.
 *
 * The client game does not receive `cvar.changed.<cvar-name>`: the whitelist forwards fixed names, and no game
 * listens for the per-name form on the client. The server game does, see `Server.ts`.
 */
export const engineEventTable = Object.freeze({
  'com.argv.ready': PAGE_ONLY,
  'com.registered': PAGE_ONLY,
  'com.ready': PAGE_ONLY,
  'com.fs.being': PAGE_ONLY,
  'com.fs.end': PAGE_ONLY,

  'client.paused': CLIENT_GAME,
  'client.unpaused': CLIENT_GAME,
  'client.cdtrack': CLIENT_GAME,
  'client.players.name-changed': CLIENT_GAME,
  'client.players.frags-updated': CLIENT_GAME,
  'client.players.colors-updated': CLIENT_GAME,
  'client.server-info.ready': CLIENT_GAME,
  'client.server-info.updated': CLIENT_GAME,
  'client.damage': CLIENT_GAME,
  'client.center-print': CLIENT_GAME,
  'client.chat.message': CLIENT_GAME,
  'client.clientdata.field-changed': CLIENT_GAME,
  'client.disconnected': CLIENT_GAME,
  'client.connecting': PAGE_ONLY,
  'client.connected': PAGE_ONLY,
  'client.signon': PAGE_ONLY,
  'client.game-initialized': PAGE_ONLY,

  'menu.page-registered': PAGE_ONLY,
  'menu.opened': PAGE_ONLY,
  'menu.closed': PAGE_ONLY,

  'console.print-line': PAGE_ONLY,

  'cvar.registered': PAGE_ONLY,
  'cvar.changed': GAME_BOTH,
  'cvar.changed.<cvar-name>': SERVER_GAME,

  'gl.ready': PAGE_ONLY,
  'gl.shutdown': PAGE_ONLY,
  'gl.texture.ready': PAGE_ONLY,
  'renderer.shaders.initialized': PAGE_ONLY,
  'renderer.textures.initialized': PAGE_ONLY,
  'vid.resize': CLIENT_GAME,

  'host.crash': PAGE_ONLY,
  'host.ready': PAGE_ONLY,
  'host.shutting-down': PAGE_ONLY,
  'host.shutdown': PAGE_ONLY,
  'host.config.loaded': PAGE_ONLY,
  'host.alert': CLIENT_GAME,
  'host.quit-requested': CLIENT_GAME,

  'net.connection.accepted': PAGE_ONLY,
  'net.connection.close': PAGE_ONLY,
  'net.connection.error': PAGE_ONLY,

  'server.spawning': CROSSES_WORKER_TO_CLIENT_GAME,
  'server.spawned': CROSSES_WORKER,
  'server.edict.assigned': PAGE_ONLY,
  'server.edict.freed': PAGE_ONLY,
  'server.shutting-down': CROSSES_WORKER,
  'server.shutdown': CROSSES_WORKER,
  'server.client.connected': CROSSES_WORKER,
  'server.client.disconnected': CROSSES_WORKER,

  'nav.load': PAGE_ONLY,
  'nav.path.request': PAGE_ONLY,
  'nav.debug.emit-dot.temporarily': CROSSES_WORKER,
  'nav.debug.emit-dot.permanently': CROSSES_WORKER,
  'nav.path.response': PAGE_ONLY,
  'nav.build': PAGE_ONLY,

  'worker.framework.init': PAGE_ONLY,
  'worker.test': PAGE_ONLY,
  'worker.busy': PAGE_ONLY,
  'worker.error': PAGE_ONLY,

  'wad.palette.loaded': PAGE_ONLY,

  'areaportals.changed': PAGE_ONLY,
} as const satisfies Record<EngineEventDocName, EngineEventMeta>);

/** What a parameterized documented name looks like: `cvar.changed.<cvar-name>`. */
const FAMILY_PLACEHOLDER = /<[^>]*>$/;

/**
 * Lists the documented names in {@link engineEventTable} that have the given flag set.
 * @param flag Which flag has to be set.
 * @returns The documented names, in the table's order.
 */
function documentedNamesWith(flag: keyof EngineEventMeta): string[] {
  const names: string[] = [];

  for (const [name, meta] of Object.entries(engineEventTable)) {
    if (meta[flag]) {
      names.push(name);
    }
  }

  return names;
}

/**
 * Lists the plain event names with the given flag set.
 * @param flag Which flag has to be set.
 * @returns The names, in the table's order.
 */
function namesWith(flag: keyof EngineEventMeta): readonly string[] {
  return Object.freeze(documentedNamesWith(flag).filter((name) => !FAMILY_PLACEHOLDER.test(name)));
}

/**
 * Lists the prefixes of the parameterized events with the given flag set (`cvar.changed.` for
 * `cvar.changed.<cvar-name>`).
 * @param flag Which flag has to be set.
 * @returns The prefixes, in the table's order.
 */
function familiesWith(flag: keyof EngineEventMeta): readonly string[] {
  return Object.freeze(documentedNamesWith(flag).filter((name) => FAMILY_PLACEHOLDER.test(name)).map((name) => name.replace(FAMILY_PLACEHOLDER, '')));
}

/** The event name a documented name stands for: the placeholder of a parameterized one becomes `${string}`. */
type EventNameOf<DocName extends string> = DocName extends `${infer Prefix}<${string}>` ? `${Prefix}${string}` : DocName;

/** The documented names in {@link engineEventTable} whose entry has the given flag set to `true`. */
type DocumentedNamesWith<Flag extends keyof EngineEventMeta> = {
  [Name in keyof typeof engineEventTable]: (typeof engineEventTable)[Name][Flag] extends true ? Name : never;
}[keyof typeof engineEventTable];

/** The names in {@link engineEventTable} whose entry has the given flag set to `true`, a parameterized one as its family. */
type EventNamesWith<Flag extends keyof EngineEventMeta> = EventNameOf<DocumentedNamesWith<Flag>>;

/** The plain names (no parameterized ones) whose entry has the given flag set to `true`. */
type PlainEventNamesWith<Flag extends keyof EngineEventMeta> = Exclude<DocumentedNamesWith<Flag>, `${string}<${string}>`>;

/** The engine events the client game's buses receive. */
export type ClientGameEventName = EventNamesWith<'clientGame'>;

/** The engine events the server game's buses receive. */
export type ServerGameEventName = EventNamesWith<'serverGame'>;

/** The engine events the server worker forwards to the page. */
export type ForwardedServerEventName = EventNamesWith<'crossesWorker'>;

/** The engine events the client game's buses receive, in the table's order. */
export const clientGameEventNames = namesWith('clientGame') as readonly PlainEventNamesWith<'clientGame'>[];

/** The prefixes of the parameterized engine events the client game's buses receive. */
export const clientGameEventFamilies = familiesWith('clientGame');

/** The plain engine events the server game's buses receive, in the table's order. */
export const serverGameEventNames = namesWith('serverGame') as readonly PlainEventNamesWith<'serverGame'>[];

/** The prefixes of the parameterized engine events the server game's buses receive (`cvar.changed.`). */
export const serverGameEventFamilies = familiesWith('serverGame');

/** The engine events the server worker forwards to the page, in the table's order. */
export const forwardedServerEventNames = namesWith('crossesWorker') as readonly PlainEventNamesWith<'crossesWorker'>[];

/** The event names {@link engineEventTable} documents, `cvar.changed.<cvar-name>` included. */
export const documentedEngineEventNames = Object.freeze(Object.keys(engineEventTable)) as readonly EngineEventDocName[];

const engineEventNameSet: ReadonlySet<string> = new Set(documentedEngineEventNames.filter((name) => !FAMILY_PLACEHOLDER.test(name)));
const engineEventFamilyPrefixes: readonly string[] = documentedEngineEventNames.filter((name) => FAMILY_PLACEHOLDER.test(name)).map((name) => name.replace(FAMILY_PLACEHOLDER, ''));

/**
 * Tells whether a name belongs to the engine, as opposed to being an event a game made up for itself.
 * @param eventName The name of an event.
 * @returns True for a name of `EngineEventMap`, or one of its parameterized families.
 */
export function isEngineEventName(eventName: string): boolean {
  return engineEventNameSet.has(eventName) || engineEventFamilyPrefixes.some((prefix) => eventName.startsWith(prefix));
}

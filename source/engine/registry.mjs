
/** @typedef {typeof import('./common/Console.mjs').default} ConModule */
/** @typedef {typeof import('./common/Com.mjs').default} ComModule */
/** @typedef {typeof import('./common/Sys.mjs').default} SysModule */
/** @typedef {typeof import('./common/Host.mjs').default} HostModule */
/** @typedef {typeof import('./client/V.mjs').default} VModule */
/** @typedef {typeof import('./network/Network.mjs').default} NetModule */
/** @typedef {typeof import('./server/Server.mjs').default} ServerModule */
/** @typedef {typeof import('./server/Progs.mjs').default} ProgsModule */
/** @typedef {typeof import('./common/Mod.mjs').default} ModModule */
/** @typedef {typeof import('./client/CL.mjs').default} ClientModule */
/** @typedef {typeof import('./client/SCR.mjs').default} ScrModule */
/** @typedef {typeof import('./client/R.mjs').default} RendererModule */
/** @typedef {typeof import('./client/Draw.mjs').default} DrawModule */
/** @typedef {typeof import('./client/Key.mjs').default} KeyModule */
/** @typedef {typeof import('./client/Sbar.mjs').default} SbarModule */
/** @typedef {typeof import('./client/Sound.mjs').default} SoundModule */
/** @typedef {typeof import('./client/Menu.mjs').default} MenuModule */
/** @typedef {typeof import('./client/IN.mjs').default} InputModule */
/** @typedef {typeof import('ws').default} WebSocketClass */
/** @typedef {import('./build-config').BuildConfig} BuildConfig */
/** @typedef {import('./build-config').URLs} URLs */
/**
 * Registry for engine components.
 * Unfortunately, the engine components are too tightly coupled, that’s why we need a registry for the time being.
 * NOTE: Before adding more components here, consider refactoring the code to use ES6 modules and imports.
 * @typedef {object} Registry
 * @property {ComModule | undefined} COM command and filesystem module
 * @property {ConModule | undefined} Con console output module
 * @property {HostModule | undefined} Host engine host lifecycle module
 * @property {NetModule | undefined} NET networking module
 * @property {DrawModule | undefined} Draw 2D drawing module
 * @property {SysModule | undefined} Sys platform system module
 * @property {VModule | undefined} V view and camera module
 * @property {ClientModule | undefined} CL client runtime module
 * @property {ServerModule | undefined} SV server runtime module
 * @property {ModModule | undefined} Mod model loading and cache module
 * @property {ProgsModule | undefined} PR game program interface module
 * @property {RendererModule | undefined} R renderer module
 * @property {ScrModule | undefined} SCR screen and HUD module
 * @property {KeyModule | undefined} Key input binding module
 * @property {InputModule | undefined} IN low-level input module
 * @property {SbarModule | undefined} Sbar status bar module
 * @property {SoundModule | undefined} S audio module
 * @property {MenuModule | undefined} M menu module
 * @property {WebSocketClass | undefined} WebSocket injected WebSocket constructor
 * @property {URLs | undefined} urls runtime URL providers
 * @property {BuildConfig | undefined} buildConfig build-time configuration snapshot
 * @property {boolean} isDedicatedServer true when running in server mode
 * @property {boolean} isInsideWorker true when running inside a worker
 */
/**
 * Registry members guaranteed after both browser and dedicated launch.
 * @typedef {Registry & {
 *   COM: ComModule,
 *   Con: ConModule,
 *   Host: HostModule,
 *   NET: NetModule,
 *   Sys: SysModule,
 *   V: VModule,
 *   SV: ServerModule,
 *   Mod: ModModule,
 *   PR: ProgsModule,
 *   WebSocket: WebSocketClass,
 * }} CommonRegistry
 */
/**
 * Registry members guaranteed only after browser launch.
 * @typedef {CommonRegistry & {
 *   CL: ClientModule,
 *   Draw: DrawModule,
 *   Key: KeyModule,
 *   IN: InputModule,
 *   M: MenuModule,
 *   R: RendererModule,
 *   S: SoundModule,
 *   Sbar: SbarModule,
 *   SCR: ScrModule,
 *   urls: URLs,
 *   buildConfig: BuildConfig,
 *   isDedicatedServer: false,
 * }} ClientRegistry
 */
/** @type {Registry} */
export const registry = {
  COM: undefined,
  Con: undefined,
  Host: undefined,
  NET: undefined,
  Draw: undefined,
  Sys: undefined,
  V: undefined,
  CL: undefined,
  SV: undefined,
  Mod: undefined,
  PR: undefined,
  R: undefined,
  SCR: undefined,
  Key: undefined,
  IN: undefined,
  Sbar: undefined,
  S: undefined,
  M: undefined,

  WebSocket: undefined,

  urls: undefined,
  buildConfig: undefined,

  /** @type {boolean} true, when running in server mode */
  isDedicatedServer: false,
  isInsideWorker: false,
};

// make sure the registry is not extensible beyond the defined properties
Object.seal(registry);

/**
 * Returns the registry members guaranteed after both browser and dedicated launch.
 * Use this from code that runs in either runtime.
 * @returns {CommonRegistry} initialized common registry view
 */
export function getCommonRegistry() {
  return /** @type {CommonRegistry} */ (registry);
}

/**
 * Returns the registry members guaranteed only after browser launch.
 * Use this only from browser or client-only code paths.
 * @returns {ClientRegistry} initialized client registry view
 */
export function getClientRegistry() {
  return /** @type {ClientRegistry} */ (registry);
}

export class EventBus {
  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map();

  /** @type {string} */
  #name;

  /**
   * @param {string} name name
   */
  constructor(name) {
    this.#name = name;
  }

  /**
   * Registers an event listener for a specific event type.
   * @param {string} eventName The event type to listen for.
   * @param {Function} listener The function to call when the event is triggered.
   * @returns {() => void} A function to remove the listener.
   */
  subscribe(eventName, listener) {
    if (!this.#listeners.has(eventName)) {
      this.#listeners.set(eventName, new Set());
    }

    this.#listeners.get(eventName).add(listener);

    return () => {
      this.#listeners.get(eventName).delete(listener);
    };
  }

  /**
   * Publishes an event, calling all registered listeners for that event type.
   * NOTE: Make sure to use arguments that are serializable. Events might be sent over the network or/and to Web Workers.
   * @param {string} eventName The event type to trigger.
   * @param {...*} args The arguments to pass to the event listeners.
   */
  publish(eventName, ...args) {
    // console.debug(`EventBus: ${this.#name} - ${eventName}`, ...args);

    if (!this.#listeners.has(eventName)) {
      return;
    }

    for (const listener of this.#listeners.get(eventName)) {
      listener(...args);
    }
  }

  /**
   * Unsubscribes from all events.
   */
  unsubscribeAll() {
    this.#listeners.clear();
  }

  toString() {
    return `EventBus(${this.#name}): ${this.#listeners.size} topics`;
  }

  /**
   * All subscribed topics.
   * @returns {string[]} topics
   */
  get topics() {
    return Array.from(this.#listeners.keys());
  }
};

/** Engine’s main event bus. */
export const eventBus = new EventBus('engine');

/**
 * Freezes the registry to prevent further modifications.
 * It will also call all registered change observers.
 */
export function freeze() {
  Object.freeze(registry);

  eventBus.publish('registry.frozen', registry);
};

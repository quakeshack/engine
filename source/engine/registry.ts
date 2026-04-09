import type { BuildConfig, URLs } from './build-config';

type ConModule = typeof import('./common/Console.ts').default;
type ComModule = typeof import('./common/Com.ts').default;
type SysModule = typeof import('./common/Sys.ts').default | typeof import('./client/Sys.ts').default | typeof import('./server/Sys.ts').default;
type HostModule = typeof import('./common/Host.ts').default;
type VModule = typeof import('./client/V.ts').default;
type NetModule = typeof import('./network/Network.ts').default;
type ServerModule = typeof import('./server/Server.ts').default;
type ProgsModule = typeof import('./server/Progs.ts').default;
type ModModule = typeof import('./common/Mod.ts').default;
type ClientModule = typeof import('./client/CL.ts').default;
type ScrModule = typeof import('./client/SCR.ts').default;
type RendererModule = typeof import('./client/R.ts').default;
type DrawModule = typeof import('./client/Draw.ts').default;
type KeyModule = typeof import('./client/Key.ts').default;
type SbarModule = typeof import('./client/Sbar.ts').default;
type SoundModule = typeof import('./client/Sound.ts').default;
type MenuModule = typeof import('./client/Menu.ts').default;
type InputModule = typeof import('./client/IN.ts').default;
type BrowserWebSocketClass = typeof globalThis.WebSocket;
type NodeWebSocketServerConstructor = typeof import('ws').WebSocketServer;

interface NodeWebSocketDependency {
  WebSocketServer: NodeWebSocketServerConstructor;
}

type WebSocketDependency = BrowserWebSocketClass | NodeWebSocketDependency;
type EventBusValue = bigint | boolean | null | number | object | string | symbol | undefined;
type EventBusArgs = readonly EventBusValue[];
type EventBusListener<TArgs extends EventBusArgs = EventBusArgs> = (...args: TArgs) => void;

/**
 * Registry for engine components.
 * Unfortunately, the engine components are too tightly coupled, that’s why we need a registry for the time being.
 * NOTE: Before adding more components here, consider refactoring the code to use ES6 modules and imports.
 */
export interface Registry {
  COM: ComModule | undefined;
  Con: ConModule | undefined;
  Host: HostModule | undefined;
  NET: NetModule | undefined;
  Draw: DrawModule | undefined;
  Sys: SysModule | undefined;
  V: VModule | undefined;
  CL: ClientModule | undefined;
  SV: ServerModule | undefined;
  Mod: ModModule | undefined;
  PR: ProgsModule | undefined;
  R: RendererModule | undefined;
  SCR: ScrModule | undefined;
  Key: KeyModule | undefined;
  IN: InputModule | undefined;
  Sbar: SbarModule | undefined;
  S: SoundModule | undefined;
  M: MenuModule | undefined;
  WebSocket: WebSocketDependency | undefined;
  urls: URLs | undefined;
  buildConfig: BuildConfig | undefined;
  isDedicatedServer: boolean;
  isInsideWorker: boolean;
}

/**
 * Registry members guaranteed after both browser and dedicated launch.
 */
export interface CommonRegistry extends Registry {
  COM: ComModule;
  Con: ConModule;
  Host: HostModule;
  NET: NetModule;
  Sys: SysModule;
  V: VModule;
  SV: ServerModule;
  Mod: ModModule;
  PR: ProgsModule;
  WebSocket: WebSocketDependency;
}

/**
 * Registry members guaranteed only after browser launch.
 */
export interface ClientRegistry extends CommonRegistry {
  CL: ClientModule;
  Draw: DrawModule;
  Key: KeyModule;
  IN: InputModule;
  M: MenuModule;
  R: RendererModule;
  S: SoundModule;
  Sbar: SbarModule;
  SCR: ScrModule;
  urls: URLs;
  buildConfig: BuildConfig;
  isDedicatedServer: false;
}

export const registry: Registry = {
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
  isDedicatedServer: false,
  isInsideWorker: false,
};

// Make sure the registry is not extensible beyond the defined properties.
Object.seal(registry);

/**
 * Returns the registry members guaranteed after both browser and dedicated launch.
 * Use this from code that runs in either runtime.
 * @returns The initialized common registry view.
 */
export function getCommonRegistry(): CommonRegistry {
  return registry as CommonRegistry;
}

/**
 * Returns the registry members guaranteed only after browser launch.
 * Use this only from browser or client-only code paths.
 * @returns The initialized client registry view.
 */
export function getClientRegistry(): ClientRegistry {
  return registry as ClientRegistry;
}

export class EventBus {
  /** All listeners grouped by topic name. */
  #listeners = new Map<string, Set<EventBusListener>>();

  /** Human-readable bus name used in diagnostics. */
  #name: string;

  /**
   * Creates a named event bus.
   * @param name Event bus name.
   */
  constructor(name: string) {
    this.#name = name;
  }

  /**
   * Registers an event listener for a specific event type.
   * @param eventName The event type to listen for.
   * @param listener The function to call when the event is triggered.
   * @returns A function that removes the listener.
   */
  subscribe<TArgs extends EventBusArgs>(eventName: string, listener: EventBusListener<TArgs>): () => void {
    if (!this.#listeners.has(eventName)) {
      this.#listeners.set(eventName, new Set());
    }

    const listeners = this.#listeners.get(eventName)!;
    const storedListener = listener as EventBusListener;
    listeners.add(storedListener);

    return (): void => {
      listeners.delete(storedListener);
    };
  }

  /**
   * Publishes an event, calling all registered listeners for that event type.
   * NOTE: Make sure to use arguments that are serializable. Events might be sent over the network or to Web Workers.
   * @param eventName The event type to trigger.
   * @param args The arguments to pass to the event listeners.
   */
  publish<TArgs extends EventBusArgs>(eventName: string, ...args: TArgs): void {
    // console.debug(`EventBus: ${this.#name} - ${eventName}`, ...args);

    const listeners = this.#listeners.get(eventName);
    if (listeners === undefined) {
      return;
    }

    for (const listener of listeners) {
      listener(...args);
    }
  }

  /**
   * Unsubscribes from all events.
   */
  unsubscribeAll(): void {
    this.#listeners.clear();
  }

  toString(): string {
    return `EventBus(${this.#name}): ${this.#listeners.size} topics`;
  }

  /**
   * All subscribed topics.
   * @returns All subscribed topic names.
   */
  get topics(): string[] {
    return Array.from(this.#listeners.keys());
  }
}

/** Engine’s main event bus. */
export const eventBus = new EventBus('engine');

/**
 * Freezes the registry to prevent further modifications.
 * It also calls all registered change observers.
 */
export function freeze(): void {
  Object.freeze(registry);

  eventBus.publish('registry.frozen', registry);
}

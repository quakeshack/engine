import type { BuildConfig, URLs } from './build-config';

import { eventBus } from './common/EventBus.ts';

type ConModule = typeof import('./common/Console.ts').default;
type ComModule = import('./common/Com.ts').default;
type SysModule = typeof import('./common/Sys.ts').default | typeof import('./client/Sys.ts').default | import('./server/Sys.ts').default;
type HostModule = typeof import('./common/Host.ts').default;
type VModule = typeof import('./client/V.ts').default;
type NetModule = import('./network/Network.ts').default;
type ServerModule = import('./server/Server.ts').default;
type ModModule = typeof import('./common/Mod.ts').default;
type ClientModule = typeof import('./client/CL.ts').default;
type ScrModule = typeof import('./client/SCR.ts').default;
type RendererModule = typeof import('./client/R.ts').default;
type DrawModule = typeof import('./client/Draw.ts').default;
type KeyModule = typeof import('./client/Key.ts').default;
type SoundModule = typeof import('./client/Sound.ts').default;
type MenuModule = typeof import('./client/Menu.ts').default;
type InputModule = typeof import('./client/IN.ts').default;
type BrowserWebSocketClass = typeof globalThis.WebSocket;
type NodeWebSocketServerConstructor = typeof import('ws').WebSocketServer;

interface NodeWebSocketDependency {
  WebSocketServer: NodeWebSocketServerConstructor;
}

type WebSocketDependency = BrowserWebSocketClass | NodeWebSocketDependency;

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
  R: RendererModule | undefined;
  SCR: ScrModule | undefined;
  Key: KeyModule | undefined;
  IN: InputModule | undefined;
  S: SoundModule | undefined;
  M: MenuModule | undefined;
  WebSocket: WebSocketDependency | undefined;
  urls: URLs | undefined;
  buildConfig: BuildConfig | undefined;
  isDedicatedServer: boolean;
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
  R: undefined,
  SCR: undefined,
  Key: undefined,
  IN: undefined,
  S: undefined,
  M: undefined,
  WebSocket: undefined,
  urls: undefined,
  buildConfig: undefined,
  isDedicatedServer: false,
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

/**
 * Freezes the registry to prevent further modifications.
 * It also calls all registered change observers.
 */
export function freeze(): void {
  Object.freeze(registry);

  eventBus.publish('registry.frozen', registry);
}

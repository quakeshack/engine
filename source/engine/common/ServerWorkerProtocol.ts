import type { BuildConfig, URLs } from '../build-config';
import type { ServerStateMirror } from './ServerController.ts';
import type { GameEdition } from './GameApiSupport.ts';
import type { SearchPath } from './Com.ts';
import type { ServerSaveResult, ServerSaveState, SessionRequest, ViewthingState } from './ServerController.ts';

/**
 * The control plane between the main thread and a server worker. The game protocol itself does not
 * travel here, it goes through the `ChannelDriver` on the same port.
 *
 * Every control message is wrapped as `{ control: ... }` so that it can share a port with the data
 * plane, see `MessagePortEndpoint`.
 */

/** What the worker needs to know to set up its realm, sent once as the first message. */
export interface ServerWorkerInit {
  /** Where the worker finds the game files; the worker never searches for them itself. */
  readonly searchpaths: SearchPath[];
  readonly gamedir: SearchPath[] | null;
  readonly game: string;
  readonly urls: URLs;
  /** Engine version shown to clients, e.g. `1.2.2+abc123`. */
  readonly engineVersion: string;
  /** Which edition of the game data is in use. */
  readonly edition: GameEdition;
  /** Command line parameters the server may care about. */
  readonly argv: string[];
  /** Build-time configuration of the page that started the worker. */
  readonly buildConfig: BuildConfig | undefined;
}

/** A console variable as the server registered it, which is what the page needs to mirror it. */
export interface CvarDescription {
  readonly name: string;
  readonly value: string;
  readonly flags: number;
  readonly description: string | null;
}

/** Things the main thread asks of the server, answered once. */
export type ServerRequest =
  | { readonly kind: 'start'; readonly mapname: string }
  | { readonly kind: 'announce-changelevel'; readonly mapname: string }
  | { readonly kind: 'changelevel'; readonly mapname: string }
  | { readonly kind: 'stop'; readonly crash: boolean }
  | { readonly kind: 'save' }
  | { readonly kind: 'restore'; readonly state: ServerSaveState; readonly source: string }
  | { readonly kind: 'viewthing' }
  | { readonly kind: 'viewthing-frame'; readonly frame: number };

/** What a request is answered with. */
export type ServerResponseValue = boolean | ServerSaveResult | ViewthingState | null;

/** Messages from the main thread to the server worker. */
export type ControlToServer =
  | { readonly kind: 'request'; readonly id: number; readonly request: ServerRequest }
  | { readonly kind: 'simulation-allowed'; readonly allowed: boolean }
  | { readonly kind: 'cvar-set'; readonly name: string; readonly value: string }
  | { readonly kind: 'command'; readonly text: string; readonly operator: string };

/** How loud a printed line is. */
export type ServerPrintLevel = 'print' | 'success' | 'warning' | 'error' | 'debug';

/** Engine events that are forwarded from the server's realm to the main thread, with their arguments. */
export const forwardedServerEvents = Object.freeze([
  'server.spawning',
  'server.spawned',
  'server.shutting-down',
  'server.shutdown',
  'server.client.connected',
  'server.client.disconnected',
  'nav.debug.emit-dot.temporarily',
  'nav.debug.emit-dot.permanently',
] as const);

/** Messages from the server worker to the main thread. */
export type ControlFromServer =
  | { readonly kind: 'ready'; readonly cvars: CvarDescription[]; readonly commands: string[] }
  | { readonly kind: 'response'; readonly id: number; readonly ok: true; readonly result: ServerResponseValue }
  | { readonly kind: 'cvar-registered'; readonly cvar: CvarDescription }
  | { readonly kind: 'cvar-changed'; readonly name: string; readonly value: string }
  | { readonly kind: 'noclip-anglehack'; readonly enabled: boolean }
  | { readonly kind: 'session-request'; readonly request: SessionRequest }
  | { readonly kind: 'response'; readonly id: number; readonly ok: false; readonly error: string }
  | { readonly kind: 'state'; readonly state: ServerStateMirror }
  | { readonly kind: 'print'; readonly level: ServerPrintLevel; readonly text: string; readonly color?: readonly [number, number, number] }
  | { readonly kind: 'event'; readonly name: (typeof forwardedServerEvents)[number]; readonly args: unknown[] }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'crash'; readonly name: string; readonly message: string; readonly stack?: string };

/** The message sent to a worker to hand it its port and settings. */
export interface ServerWorkerBoot {
  readonly event: 'server.worker.boot';
  readonly port: MessagePort;
  readonly init: ServerWorkerInit;
}

/** The part of a `MessagePort` the control plane uses. */
export interface ControlPortLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  start?(): void;
}

/**
 * A typed control plane over a message port; `Out` is what this end sends, `In` what it receives.
 */
export class ControlLink<Out, In> {
  readonly #port: ControlPortLike;

  constructor(port: ControlPortLike, onMessage: (message: In) => void) {
    this.#port = port;
    port.addEventListener('message', (event) => {
      const envelope = event.data as { readonly control?: In } | null;

      if (envelope?.control !== undefined) {
        onMessage(envelope.control);
      }
    });
    port.start?.();
  }

  /**
   * Sends a control message to the other end.
   * @param message What to send.
   */
  send(message: Out): void {
    this.#port.postMessage({ control: message });
  }
}

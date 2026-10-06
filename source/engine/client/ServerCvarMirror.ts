import type { CvarDescription } from '../common/ServerWorkerProtocol.ts';

import { eventBus } from '../common/EventBus.ts';
import Cvar from '../common/Cvar.ts';

/**
 * The console's end of keeping variables in step with a server that has a realm of its own.
 *
 * Whoever registers a variable owns it: one only the server has is mirrored here as an ordinary
 * `Cvar`, so completion, `cvarlist`, `set`, `toggle` and the configuration file see it, and the
 * server decides its value. One both sides register is shared, and the value of this side counts
 * when the two meet. Changes travel in both directions, a change that came from the other side is
 * never sent back.
 */
export default class ServerCvarMirror {
  readonly #send: (name: string, value: string) => void;
  readonly #mirrored = new Set<string>();
  readonly #shared = new Set<string>();
  #unsubscribe: (() => void) | null = null;
  #applying = false;

  constructor(send: (name: string, value: string) => void) {
    this.#send = send;
  }

  /**
   * Starts mirroring. Call after every variable of this side was registered, because shared ones keep this side's value.
   * @param cvars The variables the server has.
   */
  attach(cvars: readonly CvarDescription[]): void {
    this.#unsubscribe ??= eventBus.subscribe('cvar.changed', (name: string) => { this.#onLocalChange(name); });

    for (const description of cvars) {
      this.register(description);
    }
  }

  /**
   * Takes over a variable the server registered.
   * @param description What the server registered.
   */
  register(description: CvarDescription): void {
    const { name } = description;

    if (this.#mirrored.has(name) || this.#shared.has(name)) {
      return;
    }

    const own = Cvar.FindVar(name);

    if (own === null) {
      this.#mirrored.add(name);
      this.#applying = true;

      try {
        void new Cvar(name, description.value, description.flags, description.description);
      } finally {
        this.#applying = false;
      }

      return;
    }

    // Both sides know it, this side's value counts.
    this.#shared.add(name);

    if (own.string !== description.value) {
      this.#send(name, own.string);
    }
  }

  /**
   * Applies a value the server reports.
   * @param name Name of the variable.
   * @param value Its value on the server.
   */
  remoteChanged(name: string, value: string): void {
    const cvar = Cvar.FindVar(name);

    if (cvar === null || !(this.#mirrored.has(name) || this.#shared.has(name))) {
      return;
    }

    this.#applying = true;

    try {
      cvar.set(value);
    } finally {
      this.#applying = false;
    }
  }

  /**
   * The server is gone: its variables stay, with the values they had, but cannot be changed any more.
   */
  markInactive(): void {
    for (const name of this.#mirrored) {
      const cvar = Cvar.FindVar(name);

      if (cvar !== null) {
        cvar.flags |= Cvar.FLAG.READONLY;
      }
    }
  }

  /**
   * Stops sending changes.
   */
  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  #onLocalChange(name: string): void {
    if (this.#applying || !(this.#mirrored.has(name) || this.#shared.has(name))) {
      return;
    }

    const cvar = Cvar.FindVar(name);

    if (cvar !== null) {
      this.#send(name, cvar.string);
    }
  }
}

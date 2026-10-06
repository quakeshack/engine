import type { ControlFromServer, CvarDescription } from '../common/ServerWorkerProtocol.ts';

import { eventBus } from '../common/EventBus.ts';
import Cvar from '../common/Cvar.ts';

/**
 * The server realm's end of keeping console variables in step with the page that has the console.
 * It reports every variable the realm registers and every change that did not come from the page,
 * and applies the page's changes under the same rules as a console in this realm would: read-only
 * and cheat variables stay as they are. Whatever the page asked for is answered with the value the
 * variable has afterwards, so the page ends up with the value that counts.
 */
export default class ServerCvarSync {
  readonly #send: (message: ControlFromServer) => void;
  readonly #unsubscribe: Array<() => void> = [];
  #applying = false;

  constructor(send: (message: ControlFromServer) => void) {
    this.#send = send;
  }

  /**
   * Starts reporting new variables and changes made in this realm.
   */
  start(): void {
    this.#unsubscribe.push(
      eventBus.subscribe('cvar.registered', (name: string) => {
        const cvar = Cvar.FindVar(name);

        if (cvar !== null) {
          this.#send({ kind: 'cvar-registered', cvar: ServerCvarSync.#describe(cvar) });
        }
      }),
      eventBus.subscribe('cvar.changed', (name: string) => {
        const cvar = Cvar.FindVar(name);

        if (!this.#applying && cvar !== null) {
          this.#send({ kind: 'cvar-changed', name, value: cvar.string });
        }
      }),
    );
  }

  /**
   * Stops reporting.
   */
  stop(): void {
    for (const unsubscribe of this.#unsubscribe) {
      unsubscribe();
    }

    this.#unsubscribe.length = 0;
  }

  /**
   * Lists every variable of this realm.
   * @returns The variables as the page needs to know them.
   */
  describe(): CvarDescription[] {
    return Cvar.GetVariableNames().map((name) => ServerCvarSync.#describe(Cvar.FindVar(name)!));
  }

  /**
   * Applies a change the page made, if the rules of the variable allow it.
   * @param name Name of the variable.
   * @param value The value the page set.
   */
  apply(name: string, value: string): void {
    const cvar = Cvar.FindVar(name);

    if (cvar === null) {
      return;
    }

    if (Cvar.GetChangeBlock(cvar) === null) {
      this.#applying = true;

      try {
        cvar.set(value);
      } finally {
        this.#applying = false;
      }
    }

    this.#send({ kind: 'cvar-changed', name, value: cvar.string });
  }

  static #describe(cvar: Cvar): CvarDescription {
    return { name: cvar.name, value: cvar.string, flags: cvar.flags, description: cvar.description };
  }
}

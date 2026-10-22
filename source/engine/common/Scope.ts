import type { EngineEventMap } from '../../shared/EngineEvents.ts';
import { EventBus, GameEventBus, type EngineEventVisibility, type EventMapLike } from './EventBus.ts';

/** How long what a scope owns lives: the realm, a loaded game module, or one map. */
export type ScopeName = 'engine' | 'module' | 'map';

/** What a scope needs from the scope it lives inside. */
export interface ScopeParent {
  /** What the parent's lifetime is. */
  readonly name: ScopeName;
  /**
   * Makes the parent end a scope before it ends itself.
   * @param child The scope that lives inside the parent.
   */
  adopt(child: { end(): void }): void;
}

/** What a scope hands its game and where that comes from. */
export interface ScopeOptions<TMap extends EventMapLike<TMap>> {
  /** The scope this one lives inside. Ending the parent ends this scope first. */
  readonly parent?: ScopeParent | null;
  /** The bus the engine publishes on, which the scope forwards from. */
  readonly source: EventBus<EngineEventMap>;
  /** The plain engine events the game's bus is given. */
  readonly names: readonly (keyof EngineEventMap & keyof TMap)[];
  /** The prefixes of the parameterized engine events the game's bus is given. */
  readonly families?: readonly string[];
}

/**
 * The owner of a lifetime. Whatever the game or the engine registers through a scope is released when the scope ends,
 * so nobody unsubscribes by hand and nothing outlives the module or the map it belongs to.
 *
 * A scope is a bus of its own (`events`, what a game receives as its `eventBus`) plus the forwarding of the engine
 * events the game is given, plus a list of callbacks to run at the end. It is not a view over the engine's bus: a game
 * may publish a name the engine also uses (`client.clientdata.field-changed`) and expects its own listeners only to
 * hear it, and its own events must not reach the other scopes or the engine.
 *
 * A scope can be begun again after it has ended, which is how the map scope works: the object a game holds stays
 * valid for every map.
 */
export class Scope<TMap extends EventMapLike<TMap>> {
  readonly name: ScopeName;

  readonly parent: ScopeParent | null;

  /** The bus a game receives: engine events it is given, and its own. */
  readonly events: GameEventBus<TMap>;

  readonly #source: EventBus<EngineEventMap>;

  readonly #names: readonly (keyof EngineEventMap & keyof TMap)[];

  readonly #families: readonly string[];

  readonly #children = new Set<{ end(): void }>();

  readonly #disposers: Array<() => void> = [];

  #stopForwarding: (() => void) | null = null;

  /**
   * Creates a scope that has not begun.
   * @param name What the scope's lifetime is.
   * @param options Where its events come from and what its game is given.
   */
  constructor(name: ScopeName, options: ScopeOptions<TMap>) {
    const families = options.families ?? [];
    const given: EngineEventVisibility = { names: new Set<string>(options.names), families };

    this.name = name;
    this.parent = options.parent ?? null;
    this.events = new GameEventBus<TMap>(`${name}-scope`, given);
    this.#source = options.source;
    this.#names = options.names;
    this.#families = families;

    this.parent?.adopt(this);
  }

  /**
   * Makes this scope end a child before it ends itself.
   * @param child The scope that lives inside this one.
   */
  adopt(child: { end(): void }): void {
    this.#children.add(child);
  }

  /**
   * Whether the scope's lifetime is running.
   * @returns True between `begin()` and `end()`.
   */
  get active(): boolean {
    return this.#stopForwarding !== null;
  }

  /**
   * Starts the lifetime: the engine events the game is given reach `events` from now on.
   */
  begin(): void {
    console.assert(!this.active, `scope ${this.name} began twice`);

    if (this.active) {
      return;
    }

    const stopNames = this.#source.forward(this.#names, this.events);
    const stopFamilies = this.#source.forwardFamily(this.#families, this.events);

    this.#stopForwarding = (): void => {
      stopNames();
      stopFamilies();
    };
  }

  /**
   * Registers something to do when the lifetime ends, for engine code that holds on to a resource for as long as
   * the map or the module lives. Callbacks run in the reverse order of registration, once per lifetime.
   * @param callback What to do.
   */
  onDispose(callback: () => void): void {
    this.#disposers.push(callback);
  }

  /**
   * Ends the lifetime: the scopes inside this one end first, then the callbacks run (last registered first), then
   * everything registered on `events` is released and the forwarding stops. `unsubscribeAll()` has no exceptions: a
   * game never has to unsubscribe by hand, and does not get to keep a listener.
   */
  end(): void {
    // A callback that throws must not leave the scope holding listeners: everything is released, then the first
    // error is thrown.
    const failures: unknown[] = [];

    for (const child of this.#children) {
      this.#attempt(() => { child.end(); }, failures);
    }

    while (this.#disposers.length > 0) {
      const dispose = this.#disposers.pop()!;
      this.#attempt(dispose, failures);
    }

    this.events.unsubscribeAll();
    this.#stopForwarding?.();
    this.#stopForwarding = null;

    if (failures.length > 0) {
      throw failures[0];
    }
  }

  #attempt(callback: () => void, failures: unknown[]): void {
    try {
      callback();
    } catch (error) {
      failures.push(error);
    }
  }

  /**
   * Ends the lifetime and starts the next one, with the same `events` bus.
   */
  restart(): void {
    this.end();
    this.begin();
  }
}

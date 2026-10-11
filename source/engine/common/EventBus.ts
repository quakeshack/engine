import { isEngineEventName, type ClientGameEventName, type EngineEventMap, type EngineEventName, type ServerGameEventName } from '../../shared/EngineEvents.ts';

export type EventBusValue = bigint | boolean | null | number | object | string | symbol | undefined;
type EventBusArgs = readonly EventBusValue[];
type EventBusListener<TArgs extends EventBusArgs = EventBusArgs> = (...args: TArgs) => void;
type EventBusFamilyListener = (eventName: string, args: EventBusArgs) => void;

/** What a map of event names to argument tuples looks like: every argument list is a tuple of values. */
export type EventMapLike<TMap> = { readonly [Name in keyof TMap]: EventBusArgs };

/** The engine events a game's bus is given: the plain names, and the prefixes of the parameterized ones. */
export interface EngineEventVisibility {
  readonly names: ReadonlySet<string>;
  readonly families: readonly string[];
}

/** The engine events the client game receives. */
export type ClientGameEventMap = Pick<EngineEventMap, ClientGameEventName>;

/** The engine events the server game receives. */
export type ServerGameEventMap = Pick<EngineEventMap, ServerGameEventName>;

/**
 * A name a game may publish and listen for itself: any that is not the engine's. An engine name that the game's bus
 * does not carry resolves to `never`, so asking for it is a compile error and not a listener that is never called.
 */
export type GameOwnedEventName<Name extends string> = Name extends EngineEventName ? never : Name;

/**
 * A publish/subscribe bus. The event map decides which names a bus takes and what their arguments are, so a typo in a
 * name or a wrong payload is a compile error and costs nothing at run time.
 *
 * `eventBus` is the engine's own, typed by `EngineEventMap`. The buses a game receives are {@link GameEventBus}es.
 */
export class EventBus<TMap extends EventMapLike<TMap> = EngineEventMap> {
  /** All listeners grouped by topic name. */
  #listeners = new Map<string, Set<EventBusListener>>();

  /** Listeners of a family of names, grouped by the prefix that selects the family. */
  #families = new Map<string, Set<EventBusFamilyListener>>();

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
  subscribe<Name extends keyof TMap & string>(eventName: Name, listener: EventBusListener<TMap[Name]>): () => void {
    return this.addListener(eventName, listener as EventBusListener);
  }

  /**
   * Publishes an event, calling all registered listeners for that event type.
   * NOTE: Make sure to use arguments that are serializable. Events might be sent over the network or to Web Workers.
   * @param eventName The event type to trigger.
   * @param args The arguments to pass to the event listeners.
   */
  publish<Name extends keyof TMap & string>(eventName: Name, ...args: TMap[Name]): void {
    // console.debug(`EventBus: ${this.#name} - ${eventName}`, ...args);
    this.dispatch(eventName, args);
  }

  /**
   * Publishes an event whose name and arguments are only known at run time: what a worker or a port sent, or what
   * was typed into the console. Engine code that knows the name uses `publish`, which is checked.
   * @param eventName The event type to trigger.
   * @param args The arguments to pass to the event listeners.
   */
  publishUntyped(eventName: string, ...args: readonly unknown[]): void {
    this.dispatch(eventName, args as EventBusArgs);
  }

  /**
   * Passes the named events of this bus on to another bus, with their arguments, for as long as the returned
   * function has not been called.
   * @param eventNames The events to pass on.
   * @param target The bus that receives them.
   * @returns A function that stops forwarding all of them.
   */
  forward<TTarget extends EventMapLike<TTarget>>(eventNames: readonly (keyof TMap & keyof TTarget & string)[], target: EventBus<TTarget>): () => void {
    const unsubscribes = eventNames.map((eventName) => this.addListener(eventName, (...args: EventBusArgs) => {
      target.dispatch(eventName, args);
    }));

    return (): void => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }

  /**
   * Passes every event whose name starts with one of the prefixes on to another bus, with its arguments, for as long as
   * the returned function has not been called. This is how a parameterized event (`cvar.changed.<cvar-name>`) is
   * carried, since its names cannot be listed.
   * @param prefixes The prefixes that select the events to pass on.
   * @param target The bus that receives them.
   * @returns A function that stops forwarding all of them.
   */
  forwardFamily<TTarget extends EventMapLike<TTarget>>(prefixes: readonly string[], target: EventBus<TTarget>): () => void {
    const unsubscribes = prefixes.map((prefix) => this.addFamilyListener(prefix, (eventName, args) => {
      target.dispatch(eventName, args);
    }));

    return (): void => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }

  /**
   * Unsubscribes from all events.
   */
  unsubscribeAll(): void {
    this.#listeners.clear();
    this.#families.clear();
  }

  /**
   * How many listeners the bus holds, those of a family included. For diagnostics and for tests that check that a
   * lifetime let go of everything it registered.
   * @returns The number of registered listeners.
   */
  get listenerCount(): number {
    let count = 0;

    for (const listeners of this.#listeners.values()) {
      count += listeners.size;
    }

    for (const listeners of this.#families.values()) {
      count += listeners.size;
    }

    return count;
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

  /**
   * Adds a listener under a name without looking at it.
   * @param eventName The event type to listen for.
   * @param listener The function to call when the event is triggered.
   * @returns A function that removes the listener.
   */
  protected addListener(eventName: string, listener: EventBusListener): () => void {
    if (!this.#listeners.has(eventName)) {
      this.#listeners.set(eventName, new Set());
    }

    const listeners = this.#listeners.get(eventName)!;
    listeners.add(listener);

    return (): void => {
      listeners.delete(listener);
    };
  }

  /**
   * Calls the listeners of a name without looking at it.
   * @param eventName The event type to trigger.
   * @param args The arguments to pass to the event listeners.
   */
  protected dispatch(eventName: string, args: EventBusArgs): void {
    const listeners = this.#listeners.get(eventName);

    if (listeners !== undefined) {
      for (const listener of listeners) {
        listener(...args);
      }
    }

    if (this.#families.size === 0) {
      return;
    }

    for (const [prefix, familyListeners] of this.#families) {
      if (!eventName.startsWith(prefix)) {
        continue;
      }

      for (const listener of familyListeners) {
        listener(eventName, args);
      }
    }
  }

  /**
   * Adds a listener for every name that starts with a prefix.
   * @param prefix The start of the names to listen for.
   * @param listener The function to call with the name and the arguments.
   * @returns A function that removes the listener.
   */
  protected addFamilyListener(prefix: string, listener: EventBusFamilyListener): () => void {
    if (!this.#families.has(prefix)) {
      this.#families.set(prefix, new Set());
    }

    const listeners = this.#families.get(prefix)!;
    listeners.add(listener);

    return (): void => {
      listeners.delete(listener);
    };
  }
}

/**
 * The bus a game receives from the engine. The engine's events that the game is given are typed like on the engine's
 * bus, and anything else is the game's own event, which has whatever arguments the game gives it. An engine name that
 * was not given to the game is refused at compile time.
 */
export class GameEventBus<TMap extends EventMapLike<TMap>> extends EventBus<TMap> {
  /** Which engine events this bus is given, when it is a game's bus. A bus without it does not check. */
  readonly #given: EngineEventVisibility | null;

  /**
   * Creates the bus of a game.
   * @param name Event bus name.
   * @param given The engine events the bus is given. A name of the engine outside of it is a mistake in the game, which
   * `console.assert` reports in development builds.
   */
  constructor(name: string, given: EngineEventVisibility | null = null) {
    super(name);
    this.#given = given;
  }

  override subscribe<Name extends keyof TMap & string>(eventName: Name, listener: EventBusListener<TMap[Name]>): () => void;
  override subscribe<Name extends string, TArgs extends EventBusArgs>(eventName: GameOwnedEventName<Name>, listener: EventBusListener<TArgs>): () => void;
  override subscribe(eventName: string, listener: EventBusListener<never>): () => void {
    console.assert(this.#isGiven(eventName), `"${eventName}" is an engine event this bus is not given, a listener on it is never called`);
    return this.addListener(eventName, listener as EventBusListener);
  }

  override publish<Name extends keyof TMap & string>(eventName: Name, ...args: TMap[Name]): void;
  override publish<Name extends string, TArgs extends EventBusArgs>(eventName: GameOwnedEventName<Name>, ...args: TArgs): void;
  override publish(eventName: string, ...args: EventBusArgs): void {
    console.assert(this.#isGiven(eventName), `"${eventName}" is an engine event this bus is not given, a game does not publish it`);
    this.dispatch(eventName, args);
  }

  /**
   * Tells whether a name is one the game may use on this bus: its own, or an engine event the bus is given.
   * @param eventName The name of an event.
   * @returns False for an engine event that the engine does not hand to this game.
   */
  #isGiven(eventName: string): boolean {
    if (this.#given === null || !isEngineEventName(eventName)) {
      return true;
    }

    return this.#given.names.has(eventName) || this.#given.families.some((prefix) => eventName.startsWith(prefix));
  }
}

/** Engine’s main event bus. */
export const eventBus = new EventBus('engine');

export type EventBusValue = bigint | boolean | null | number | object | string | symbol | undefined;
type EventBusArgs = readonly EventBusValue[];
type EventBusListener<TArgs extends EventBusArgs = EventBusArgs> = (...args: TArgs) => void;

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

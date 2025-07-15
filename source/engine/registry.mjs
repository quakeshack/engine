
/**
 * Registry for engine components.
 * Unfortunately, the engine components are too tightly coupled, that’s why we need a registry for the time being.
 * NOTE: Before adding more components here, consider refactoring the code to use ES6 modules and imports.
 * @type {import("./registry").Registry}
 */
export const registry = {
  COM: null,
  Con: null,
  Host: null,
  Cmd: null,
  NET: null,
  Draw: null,
  Sys: null,
  V: null,
  CL: null,
  SV: null,
  Mod: null,
  PR: null,
  GL: null,
  R: null,
  SCR: null,
  Key: null,
  Chase: null,
  CDAudio: null,
  IN: null,
  Sbar: null,
  S: null,

  WebSocket: null,

  /** @type {boolean} true, when running in server mode */
  isDedicatedServer: null,
};

// make sure the registry is not extensible beyond the defined properties
Object.seal(registry);

export class EventBus {
  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map();

  /** @type {string} */
  #name = null;

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
   * @returns {Function} A function to remove the listener.
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

  toString() {
    return `EventBus(${this.#name}): ${this.#listeners.size} topics`;
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

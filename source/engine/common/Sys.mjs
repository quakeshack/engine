import { NotImplementedError } from './Errors.ts';

export class BaseWorker {
  /** @type {Function[]} @protected */
  _shutdownListeners = [];

  /**
   * @param {string} name name of the worker
   */
  constructor(name) {
    this.name = name;
  }

  // eslint-disable-next-line no-unused-vars
  addOnMessageListener(listener) {
    throw new NotImplementedError('Worker.addOnMessageListener must be implemented in a subclass');
  }

  addOnShutdownListener(listener) {
    this._shutdownListeners.push(listener);
  }

  // eslint-disable-next-line no-unused-vars
  postMessage(message) {
    throw new NotImplementedError('Worker.postMessage must be implemented in a subclass');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async shutdown() {
    throw new NotImplementedError('Worker.shutdown must be implemented in a subclass');
  }
};

/** Base class for Sys implementations. */
export default class Sys {
  // eslint-disable-next-line @typescript-eslint/require-await
  static async Init() {
    throw new NotImplementedError('Sys.Init must be implemented in a subclass');
  }

  static Quit() {
    throw new NotImplementedError('Sys.Quit must be implemented in a subclass');
  }

  // eslint-disable-next-line no-unused-vars
  static Print(text) {
    throw new NotImplementedError('Sys.Print must be implemented in a subclass');
  }

  /** @returns {number} uptime in seconds */
  static FloatTime() {
    throw new NotImplementedError('Sys.GetTime must be implemented in a subclass');
    // eslint-disable-next-line no-unreachable
    return 0;
  }

  /** @returns {number} uptime in milliseconds, containing microseconds */
  static FloatMilliTime() {
    throw new NotImplementedError('Sys.FloatMilliTime must be implemented in a subclass');
    // eslint-disable-next-line no-unreachable
    return 0;
  }
};

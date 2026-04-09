import { NotImplementedError } from './Errors.ts';

/** Message listener callback for worker communication. */
export type WorkerMessageListener = (message: unknown) => void;

/** Shutdown listener callback. */
export type WorkerShutdownListener = () => void;

/**
 * Abstract base class for platform-specific worker implementations.
 *
 * Subclassed by `PlatformWorker` for both browser (Web Worker) and
 * Node.js (worker_threads) environments.
 */
export class BaseWorker {
  protected _shutdownListeners: WorkerShutdownListener[] = [];

  /** Display name of this worker instance. */
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  addOnMessageListener(_listener: WorkerMessageListener) {
    throw new NotImplementedError('Worker.addOnMessageListener must be implemented in a subclass');
  }

  addOnShutdownListener(listener: WorkerShutdownListener) {
    this._shutdownListeners.push(listener);
  }

  postMessage(_message: unknown) {
    throw new NotImplementedError('Worker.postMessage must be implemented in a subclass');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async shutdown() {
    throw new NotImplementedError('Worker.shutdown must be implemented in a subclass');
  }
}

/**
 * Abstract base class for platform system services.
 *
 * Provides the contract for initialization, output, and timing that
 * platform-specific implementations (`client/Sys`, `server/Sys`,
 * `WorkerSys`) must fulfil.
 */
export default class Sys {
  // eslint-disable-next-line @typescript-eslint/require-await
  static async Init() {
    throw new NotImplementedError('Sys.Init must be implemented in a subclass');
  }

  static Quit(): never {
    throw new NotImplementedError('Sys.Quit must be implemented in a subclass');
  }

  static Print(_text: string) {
    throw new NotImplementedError('Sys.Print must be implemented in a subclass');
  }

  static FloatTime(): number {
    throw new NotImplementedError('Sys.GetTime must be implemented in a subclass');
  }

  static FloatMilliTime(): number {
    throw new NotImplementedError('Sys.FloatMilliTime must be implemented in a subclass');
  }
}

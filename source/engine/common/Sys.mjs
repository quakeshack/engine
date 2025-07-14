import { NotImplementedError } from './Errors.mjs';

/** Base class for Sys implementations. */
export default class Sys {
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

  static FloatTime() {
    throw new NotImplementedError('Sys.GetTime must be implemented in a subclass');
  }
};

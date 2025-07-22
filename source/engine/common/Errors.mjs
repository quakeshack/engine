// When in doubt where to put an exception that many modules can use, put it here.

/**
 * Causes the engine to crash with an error message.
 * Loosely based on Sys.Error.
 */
export class SysError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SysError';
  }
};

/**
 * Causes a Host.Error.
 * Breaks the current frame, instantly stops the game and displays the error message.
 */
export class HostError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HostError';
  }
};

/**
 * NOTE: Use subclasses of SysError to provide more context about the error.
 */
export class ResourceError extends SysError {
  resource = null;
  error = null;
};

/**
 * Use this error when a required resource could not be loaded.
 * Replaces `Sys.Error('Couldn\'t load gfx/palette.lmp');` stanza.
 */
export class MissingResourceError extends ResourceError {
  /**
   * @param {string} resource filename
   * @param {*} error optional error object, e.g. from a failed fetch
   */
  constructor(resource, error = null) {
    super(`Couldn't load ${resource}`);
    this.resource = resource;
    this.error = error;
    this.name = 'MissingResourceError';
  }
};

export class CorruptedResourceError extends ResourceError {
  /**
   * @param {string} resource filename
   * @param {string} reason optional reason why the resource is considered corrupted
   */
  constructor(resource, reason) {
    super(`${resource} is corrupted: ${reason}`);
    this.resource = resource;
    this.error = null;
    this.reason = reason;
    this.name = 'CorruptedResourceError';
  }
};

/**
 * Use this error when a method is not implemented in a subclass.
 */
export class NotImplementedError extends SysError {
  /**
   * @param {string} message message what’s not implemented
   */
  constructor(message) {
    super(message);
    this.name = 'NotImplementedError';
  }
};

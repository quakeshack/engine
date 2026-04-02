type ResourceLoadError = Error | null;

/**
 * Causes the engine to crash with an error message.
 */
export class SysError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SysError';
  }
}

/**
 * Break the current frame, stop the game, and display the error message.
 */
export class HostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostError';
  }
}

/**
 * Base resource failure carrying the resource name and an optional underlying error.
 */
export class ResourceError extends SysError {
  resource: string | null = null;
  error: ResourceLoadError = null;
}

/**
 * Use this when a required resource could not be loaded.
 */
export class MissingResourceError extends ResourceError {
  constructor(resource: string, error: ResourceLoadError = null) {
    super(`Couldn't load ${resource}`);
    this.resource = resource;
    this.error = error;
    this.name = 'MissingResourceError';
  }
}

/**
 * Use this when a resource exists but fails validation.
 */
export class CorruptedResourceError extends ResourceError {
  reason: string;

  constructor(resource: string, reason: string) {
    super(`${resource} is corrupted: ${reason}`);
    this.resource = resource;
    this.error = null;
    this.reason = reason;
    this.name = 'CorruptedResourceError';
  }
}

/**
 * Use this when a subclass must provide an implementation.
 */
export class NotImplementedError extends SysError {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

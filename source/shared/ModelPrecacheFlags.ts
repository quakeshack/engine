/**
 * Hints a server gives with each model of its precache list, sent to the clients in the `serverdata` message
 * (one byte after every model name, since protocol 43). A flag only saves work, a client that ignored it would
 * still see the same model.
 */
export enum ModelPrecacheFlags {
  none = 0,
  /** The model has no sidecar file (`<model>.json`), so nobody needs to look for it. */
  noSidecar = 1 << 0,
}

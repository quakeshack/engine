/** Stands for "this global does not exist" in {@link installGlobals}. */
export const ABSENT = Symbol('absent');

/**
 * Installs stand-ins for browser globals that Node does not have, or has in another shape.
 * @param stubs The globals to install by name; {@link ABSENT} removes one.
 * @returns A function that puts every global back as it was.
 */
export function installGlobals(stubs: Record<string, unknown>): () => void {
  const previous = new Map<string, PropertyDescriptor | undefined>();

  for (const [name, value] of Object.entries(stubs)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));

    if (value === ABSENT) {
      Reflect.deleteProperty(globalThis, name);
    } else {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
  }

  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, name);
      } else {
        Object.defineProperty(globalThis, name, descriptor);
      }
    }
  };
}

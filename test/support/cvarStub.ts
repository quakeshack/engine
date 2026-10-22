import type Cvar from '../../source/engine/common/Cvar.ts';

/**
 * A console variable for a test that only reads `value`, without registering anything in the realm's cvar table.
 * @param value What the code under test reads from the variable.
 * @returns The stand-in, typed as the real class because the code under test takes a `Cvar`.
 */
export function createCvarStub(value: number | string): Cvar {
  // The stand-in has just what a reader of `value` uses; building a real `Cvar` would register it in the global table.
  return { value, string: String(value) } as unknown as Cvar;
}

/**
 * A console variable that holds a number and can be set, as a game reads and writes a cvar it owns.
 * @param initialValue The number the variable starts with.
 * @returns The stand-in, typed as the real class because the code under test takes a `Cvar`.
 */
export function createMutableCvarStub(initialValue: number | string): Cvar {
  const cvar = {
    value: Number(initialValue),
    string: String(Number(initialValue)),
    set(nextValue: number | string): void {
      cvar.value = Number(nextValue);
      cvar.string = String(cvar.value);
    },
    free(): void {},
  };

  // As in createCvarStub: a real `Cvar` would register itself in the global table.
  return cvar as unknown as Cvar;
}

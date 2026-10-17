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

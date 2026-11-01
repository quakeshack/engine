import type { ModelPrecacheFlags } from '../../shared/ModelPrecacheFlags.ts';
import type { SzBuffer } from './MSG.ts';

/** The model list of a `svc_serverdata` message as the client reads it. Index 0 is unused, like the server's list. */
export interface ReceivedModelPrecacheList {
  readonly names: string[];
  readonly flags: ModelPrecacheFlags[];
}

/**
 * The model list inside `svc_serverdata`: for each model after the unused first entry its name (a string) and,
 * since protocol 43, one byte of {@link ModelPrecacheFlags}; an empty name ends the list.
 */
export class ModelPrecacheList {
  /**
   * @param message Where to write.
   * @param names The server's precache list, entry 0 is not sent.
   * @param flags The hint of each entry, by the same index; an entry without one has none.
   */
  static write(message: SzBuffer, names: readonly string[], flags: readonly ModelPrecacheFlags[]): void {
    for (let index = 1; index < names.length; index++) {
      message.writeString(names[index]);
      message.writeByte(flags[index] ?? 0);
    }

    message.writeByte(0);
  }

  /**
   * @param message Where to read from, positioned at the first model name.
   * @returns The names and hints, from index 1.
   */
  static read(message: SzBuffer): ReceivedModelPrecacheList {
    const names: string[] = [];
    const flags: ModelPrecacheFlags[] = [];

    for (let index = 1; ; index++) {
      const name = message.readString();

      if (name.length === 0) {
        break;
      }

      names[index] = name;
      flags[index] = message.readByte();
    }

    return { names, flags };
  }
}

import { getClientRegistry } from '../../registry.ts';
import { eventBus } from '../../common/EventBus.ts';

let { COM } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM } = getClientRegistry());
});

interface SaveGameData {
  comment?: string;
  mapname?: string;
}

export interface SaveSlotInfo {
  readonly index: number;
  readonly label: string;
  readonly mapname: string | null;
  readonly hasData: boolean;
}

/**
 * Save-slot metadata/deletion, kept behind this API so callers (the built-in save/load
 * pages, and eventually mod-authored ones) never need to know where `Host.ts`'s save/load
 * commands actually keep the files.
 *
 * The files live in the user store, which is asynchronous, while menus ask for the list while
 * they draw. So the list is answered from a snapshot of the slots' metadata that `refresh()`
 * takes at startup and after every save; a slot written by something else is not seen until then.
 */
export default class SaveSlots {
  /** How many slots are looked up when the snapshot is taken, an upper bound for what a game asks for. */
  static readonly MAX_SLOTS = 32;

  static #snapshot = new Map<number, SaveGameData>();

  static #path(index: number): string {
    return `${COM.GetGamedir()}/s${index}.json`;
  }

  /**
   * Reads the metadata of all slots from the user store into the snapshot `list()` answers from.
   */
  static async refresh(): Promise<void> {
    const snapshot = new Map<number, SaveGameData>();

    for (let index = 0; index < SaveSlots.MAX_SLOTS; index++) {
      const raw = await COM.userStore?.read(SaveSlots.#path(index)) ?? null;

      if (raw === null) {
        continue;
      }

      try {
        snapshot.set(index, JSON.parse(new TextDecoder('iso-8859-1').decode(raw)) as SaveGameData);
      } catch {
        // A save that cannot be read shows up as an empty slot, loading it reports the damage.
      }
    }

    SaveSlots.#snapshot = snapshot;
  }

  /**
   * List metadata for save slots `0..maxSlots - 1` in the currently active game directory.
   * @returns Metadata for each slot.
   */
  static list(maxSlots: number): SaveSlotInfo[] {
    const slots: SaveSlotInfo[] = [];

    for (let index = 0; index < maxSlots; index++) {
      const gamestate = SaveSlots.#snapshot.get(index);

      if (gamestate === undefined) {
        slots.push({ index, label: 'Empty slot', mapname: null, hasData: false });
        continue;
      }

      slots.push({
        index,
        label: gamestate.comment || gamestate.mapname || '',
        mapname: gamestate.mapname ?? null,
        hasData: true,
      });
    }

    return slots;
  }

  /**
   * Delete a save slot's data. The slot is empty right away, the file follows asynchronously.
   */
  static delete(index: number): void {
    SaveSlots.#snapshot.delete(index);
    void COM.userStore?.remove(SaveSlots.#path(index));
  }
}

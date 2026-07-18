import { eventBus, getClientRegistry } from '../../registry.ts';

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
 * pages, and eventually mod-authored ones) never need to know the `localStorage` key format
 * `Host.ts`'s save/load commands actually use.
 */
export default class SaveSlots {
  static #storageKey(index: number): string {
    return `Quake.${COM.gamedir![0].filename}/s${index}.json`;
  }

  /**
   * List metadata for save slots `0..maxSlots - 1` in the currently active game directory.
   * @returns Metadata for each slot.
   */
  static list(maxSlots: number): SaveSlotInfo[] {
    const slots: SaveSlotInfo[] = [];

    for (let index = 0; index < maxSlots; index++) {
      const raw = localStorage.getItem(SaveSlots.#storageKey(index));

      if (raw === null) {
        slots.push({ index, label: 'Empty slot', mapname: null, hasData: false });
        continue;
      }

      const gamestate = JSON.parse(raw) as SaveGameData;
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
   * Delete a save slot's data.
   */
  static delete(index: number): void {
    localStorage.removeItem(SaveSlots.#storageKey(index));
  }
}

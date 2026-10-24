import { PakFile } from '../../source/engine/common/PakFile.ts';
import type { GameFolder } from '../../source/engine/common/SearchPathAssetSource.ts';

/**
 * Builds a `.pak` archive: the header, the files one after another, the directory last (as id's tools write it).
 * @param files File contents by name, in directory order.
 * @returns The archive's bytes.
 */
export function createPak(files: Readonly<Record<string, readonly number[]>>): Uint8Array<ArrayBuffer> {
  const names = Object.keys(files);
  const dataLength = names.reduce((sum, name) => sum + files[name].length, 0);
  const directoryOffset = PakFile.HEADER_SIZE + dataLength;
  const bytes = new Uint8Array(directoryOffset + names.length * PakFile.ENTRY_SIZE);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, PakFile.MAGIC, true);
  view.setUint32(4, directoryOffset, true);
  view.setUint32(8, names.length * PakFile.ENTRY_SIZE, true);

  let filepos = PakFile.HEADER_SIZE;

  for (const [i, name] of names.entries()) {
    const entryOffset = directoryOffset + i * PakFile.ENTRY_SIZE;

    bytes.set(files[name], filepos);
    bytes.set([...name].map((character) => character.charCodeAt(0)), entryOffset);
    view.setUint32(entryOffset + PakFile.NAME_SIZE, filepos, true);
    view.setUint32(entryOffset + PakFile.NAME_SIZE + 4, files[name].length, true);
    filepos += files[name].length;
  }

  return bytes;
}

/**
 * A game folder in memory. It records every path it is asked to open, found or not.
 */
export class MemoryGameFolder implements GameFolder {
  /** File contents by path below the folder (`id1/pak0.pak`). */
  readonly files: Map<string, Uint8Array<ArrayBuffer>>;
  /** Every path asked for, in order. */
  readonly opened: string[] = [];

  /**
   * @param files File contents by path below the folder.
   */
  constructor(files: Readonly<Record<string, Uint8Array<ArrayBuffer> | readonly number[]>> = {}) {
    this.files = new Map(Object.entries(files).map(([path, data]) => [path, data instanceof Uint8Array ? data : new Uint8Array(data)]));
  }

  open(path: string): Promise<Blob | null> {
    this.opened.push(path);

    const data = this.files.get(path);

    return Promise.resolve(data === undefined ? null : new Blob([data]));
  }
}

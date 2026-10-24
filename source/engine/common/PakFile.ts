import Q from '../../shared/Q.ts';
import { CRC16CCITT } from './CRC.ts';
import { CorruptedResourceError } from './Errors.ts';

/** A file entry inside a .pak archive. */
export interface PackFileEntry {
  readonly name: string;
  readonly filepos: number;
  readonly filelen: number;
}

/** The directory of a .pak archive, see {@link PakFile.readDirectory}. */
export interface PakDirectory {
  /** The files of the archive, names in lower case, in the order of the archive. */
  readonly entries: PackFileEntry[];
  /** CRC-16 of the raw directory. id's check for a modified `id1/pak0.pak` compares it with 32981. */
  readonly checksum: number;
}

/**
 * The `.pak` archive format: a 12-byte header (`PACK`, directory offset, directory length) and a directory of
 * 64-byte entries (56-byte name, offset, length).
 *
 * It does no I/O of its own and reads from a `Blob`, which is what both a browser `File` and Node's
 * `fs.openAsBlob` are: only the header, the directory and the entries asked for are read, never the whole archive.
 */
export class PakFile {
  /** `PACK` read as a little-endian 32-bit integer. */
  static readonly MAGIC = 0x4b434150;
  static readonly HEADER_SIZE = 12;
  static readonly ENTRY_SIZE = 64;
  static readonly NAME_SIZE = 56;

  private constructor() {
    // Static-only helper class.
  }

  /**
   * Reads the directory of an archive.
   * @param pak The archive.
   * @param name The archive's name, for errors.
   * @returns The directory.
   */
  static async readDirectory(pak: Blob, name: string): Promise<PakDirectory> {
    if (pak.size < PakFile.HEADER_SIZE) {
      throw new CorruptedResourceError(name, 'not a valid pack file');
    }

    const header = new DataView(await pak.slice(0, PakFile.HEADER_SIZE).arrayBuffer());

    if (header.getUint32(0, true) !== PakFile.MAGIC) {
      throw new CorruptedResourceError(name, 'not a valid pack file');
    }

    const directoryOffset = header.getUint32(4, true);
    const directoryLength = header.getUint32(8, true);

    if (directoryOffset + directoryLength > pak.size) {
      throw new CorruptedResourceError(name, 'the directory lies outside the file');
    }

    const directory = new Uint8Array(await pak.slice(directoryOffset, directoryOffset + directoryLength).arrayBuffer());

    return {
      entries: PakFile.parseDirectory(directory),
      checksum: CRC16CCITT.Block(directory),
    };
  }

  /**
   * Parses the raw directory of an archive.
   * @param directory The directory's bytes, a whole number of entries.
   * @returns The entries, names in lower case.
   */
  static parseDirectory(directory: Uint8Array): PackFileEntry[] {
    const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
    const count = Math.floor(directory.byteLength / PakFile.ENTRY_SIZE);
    const entries: PackFileEntry[] = [];

    for (let i = 0; i < count; i++) {
      const offset = i * PakFile.ENTRY_SIZE;

      entries.push({
        name: Q.memstr(directory.subarray(offset, offset + PakFile.NAME_SIZE)).toLowerCase(),
        filepos: view.getUint32(offset + PakFile.NAME_SIZE, true),
        filelen: view.getUint32(offset + PakFile.NAME_SIZE + 4, true),
      });
    }

    return entries;
  }

  /**
   * Reads one file of an archive.
   * @param pak The archive.
   * @param entry The file's entry in the archive's directory.
   * @param name The archive's name, for errors.
   * @returns The file's bytes.
   */
  static async readEntry(pak: Blob, entry: PackFileEntry, name: string): Promise<ArrayBuffer> {
    if (entry.filepos + entry.filelen > pak.size) {
      throw new CorruptedResourceError(name, `${entry.name} lies outside the file`);
    }

    return await pak.slice(entry.filepos, entry.filepos + entry.filelen).arrayBuffer();
  }
}

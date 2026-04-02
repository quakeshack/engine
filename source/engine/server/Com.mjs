/* global Buffer */

import { promises as fsPromises, existsSync, writeFileSync, constants } from 'fs';

import Q from '../../shared/Q.ts';
import { CRC16CCITT as CRC } from '../common/CRC.ts';
import COM from '../common/Com.mjs';

import { CorruptedResourceError } from '../common/Errors.ts';
import { registry, eventBus } from '../registry.mjs';

let { Con, Sys } = registry;

eventBus.subscribe('registry.frozen', () => {
  Con = registry.Con;
  Sys = registry.Sys;
});

// @ts-ignore
export default class NodeCOM extends COM {

  /**
   * Loads a file, searching through registered search paths and packs.
   * @param {string} filename - The name of the file to load.
   * @returns {Promise<ArrayBuffer|null>} - The file content as an ArrayBuffer or undefined if not found.
   */
  static async LoadFile(filename) {
    filename = filename.toLowerCase();

    // Loop over search paths in reverse
    for (let i = this.searchpaths.length - 1; i >= 0; i--) {
      const search = this.searchpaths[i];
      const netpath = search.filename ? `${search.filename}/${filename}` : filename;

      // 1) Search within pack files
      for (let j = search.pack.length - 1; j >= 0; j--) {
        const pak = search.pack[j];

        for (const file of pak) {
          if (file.name !== filename) {
            continue;
          }

          // Found a matching file in the PAK metadata
          if (file.filelen === 0) {
            // The file length is zero, return an empty buffer
            return new ArrayBuffer(0);
          }

          const packPath = `data/${search.filename !== '' ? search.filename + '/' : ''}pak${j}.pak`;

          let fd;
          try {
            // Open the .pak file
            fd = await fsPromises.open(packPath, 'r');

            // Read the bytes
            const buffer = Buffer.alloc(file.filelen);
            await fd.read(buffer, 0, file.filelen, file.filepos);

            Sys.Print(`PackFile: ${packPath} : ${filename}\n`);
            return new Uint8Array(buffer).buffer;
            // eslint-disable-next-line no-unused-vars
          } catch (err) {
            // If we can't open or read from the PAK, just continue searching
          } finally {
            if (fd) {
              await fd.close();
            }
          }
        }
      }

      // 2) Search directly on the filesystem
      const directPath = `data/${netpath}`;

      try {
        // Check if file is accessible
        await fsPromises.access(directPath, constants.F_OK);

        // If we got here, the file exists—read and return its contents
        const buffer = await fsPromises.readFile(directPath);
        Sys.Print(`FindFile: ${netpath}\n`);
        return new Uint8Array(buffer).buffer;
        // eslint-disable-next-line no-unused-vars
      } catch (err) {
        // Not accessible or doesn't exist—keep searching
      }
    }

    // If we exhaust all search paths and files, the file was not found
    Sys.Print(`FindFile: can't find ${filename}\n`);
    return null;
  };

  static Shutdown() {
  };

  /**
   * Loads and parses a pack file.
   * @param {string} packfile - The path to the pack file.
   * @returns {Promise<Array<object> | null>} - The parsed pack file entries or null if the file doesn't exist.
   */
  static async LoadPackFile(packfile) {
    if (!existsSync(`data/${packfile}`)) { // CR: wanna see something ugly? check out the async version of existsSync…
      return null;
    }

    const fd = await fsPromises.open(`data/${packfile}`, 'r');

    try {
      // Read and validate the pack file header
      const headerBuffer = Buffer.alloc(12);
      await fd.read(headerBuffer, 0, 12, 0);

      const header = new DataView(new Uint8Array(headerBuffer).buffer);
      if (header.getUint32(0, true) !== 0x4b434150) { // "PACK" magic number
        throw new CorruptedResourceError(packfile, 'not a valid pack file');
      }

      const dirofs = header.getUint32(4, true);
      const dirlen = header.getUint32(8, true);
      const numpackfiles = dirlen >> 6; // Each entry is 64 bytes

      if (numpackfiles !== 339) {
        this.modified = true;
      }

      const pack = [];

      if (numpackfiles > 0) {
        const infoBuffer = Buffer.alloc(dirlen);
        await fd.read(infoBuffer, 0, dirlen, dirofs);

        const uint8ArrayInfo = new Uint8Array(infoBuffer);
        if (CRC.Block(uint8ArrayInfo) !== 32981) {
          this.modified = true;
        }

        const dv = new DataView(uint8ArrayInfo.buffer);

        for (let i = 0; i < numpackfiles; i++) {
          const offset = i << 6; // 64 bytes per entry

          pack.push({
            name: Q.memstr(uint8ArrayInfo.slice(offset, offset + 56)).toLowerCase(),
            filepos: dv.getUint32(offset + 56, true),
            filelen: dv.getUint32(offset + 60, true),
          });
        }
      }

      Con.Print(`Added packfile ${packfile} (${numpackfiles} files)\n`);

      return pack;
    } finally {
      await fd.close();
    }
  }

  // eslint-disable-next-line no-unused-vars
  static async WriteFile(filename, data, len) { // FIXME: len is actually required, needs to be async
    const filepath = `data/${this.searchpaths[this.searchpaths.length - 1].filename}/${filename.toLowerCase()}`;

    try {
      await fsPromises.writeFile(filepath, data);
    } catch (e) {
      Sys.Print('COM.WriteFile: failed on ' + filename + ', ' + e.message + '\n');
      return false;
    }
    Sys.Print('COM.WriteFile: ' + filename + '\n');
    return true;
  }

  static WriteTextFile(filename, data) {
    const filepath = `data/${this.searchpaths[this.searchpaths.length - 1].filename}/${filename.toLowerCase()}`;

    try {
      writeFileSync(filepath, data);
    } catch (e) {
      Sys.Print('COM.WriteTextFile: failed on ' + filename + ', ' + e.message + '\n');
      return false;
    }
    Sys.Print('COM.WriteTextFile: ' + filename + '\n');
    return true;
  }

  static async AddGameDirectory(dir) {
    const search = { filename: dir, pack: [] };
    for (let i = 0; ; i++) {
      const pak = await this.LoadPackFile((dir !== '' ? dir + '/' : '') + 'pak' + i + '.pak');
      if (pak === null) {
        break;
      }
      search.pack[search.pack.length] = pak;
    }
    this.searchpaths[this.searchpaths.length] = search;
  }

  static Path_f() {
    Con.Print('Current search path:\n');
    for (let i = NodeCOM.searchpaths.length - 1; i >= 0; i--) {
      const s = NodeCOM.searchpaths[i];
      Con.Print(`  ${s.filename}/ (virtual Quake filesystem)\n`);
    }
  }
};

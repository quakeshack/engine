/* global Buffer */

import { promises as fsPromises, openSync, readSync, closeSync, existsSync, readFileSync, constants } from 'fs';

import Q from '../common/Q.mjs';
import { CRC16CCITT as CRC } from '../common/CRC.mjs';
import COM from '../common/Com.mjs';

import { CorruptedResourceError } from '../common/Errors.mjs';
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
   * @returns {ArrayBuffer | undefined} - The file content as an ArrayBuffer or undefined if not found.
   */
  static LoadFile(filename) {
    filename = filename.toLowerCase();

    for (let i = this.searchpaths.length - 1; i >= 0; i--) {
      const search = this.searchpaths[i];
      const netpath = search.filename ? `${search.filename}/${filename}` : filename;

      // Search within pack files
      for (let j = search.pack.length - 1; j >= 0; j--) {
        const pak = search.pack[j];

        for (const file of pak) {
          if (file.name !== filename) {
            continue;
          }

          if (file.filelen === 0) {
            return new ArrayBuffer(0);
          }

          const packPath = `data/${search.filename !== '' ? search.filename + '/' : ''}pak${j}.pak`;
          const fd = openSync(packPath, 'r');

          try {
            const buffer = Buffer.alloc(file.filelen);
            readSync(fd, buffer, 0, file.filelen, file.filepos);

            Sys.Print(`PackFile: ${packPath} : ${filename}\n`);
            return new Uint8Array(buffer).buffer;
          } finally {
            closeSync(fd);
          }
        }
      }

      // Search in the filesystem
      if (existsSync(`data/${netpath}`)) {
        const buffer = readFileSync(`data/${netpath}`);
        Sys.Print(`FindFile: ${netpath}\n`);
        return new Uint8Array(buffer).buffer;
      }
    }

    Sys.Print(`FindFile: can't find ${filename}\n`);
    return null;
  };

  static async LoadFileAsync(filename) {
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
   * @returns {Array<object> | undefined} - The parsed pack file entries or undefined if the file doesn't exist.
   */
  static LoadPackFile(packfile) {
    if (!existsSync(`data/${packfile}`)) {
      return null;
    }

    const fd = openSync(`data/${packfile}`, 'r');

    try {
      // Read and validate the pack file header
      const headerBuffer = Buffer.alloc(12);
      readSync(fd, headerBuffer, 0, 12, 0);

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
        readSync(fd, infoBuffer, 0, dirlen, dirofs);

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
      closeSync(fd);
    }
  }
};

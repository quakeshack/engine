/* global Con, COM, Q, Sys, CRC, Buffer */

// Enhanced COM.js replacements
const fs = require('fs');

/**
 * Loads a file, searching through registered search paths and packs.
 * @param {string} filename - The name of the file to load.
 * @return {ArrayBuffer | undefined} - The file content as an ArrayBuffer or undefined if not found.
 */
COM.LoadFile = function(filename) {
  filename = filename.toLowerCase();

  for (let i = COM.searchpaths.length - 1; i >= 0; i--) {
    const search = COM.searchpaths[i];
    const netpath = search.filename ? `${search.filename}/${filename}` : filename;

    // Search within pack files
    for (let j = search.pack.length - 1; j >= 0; j--) {
      const pak = search.pack[j];

      for (const file of pak) {
        if (file.name !== filename) continue;

        if (file.filelen === 0) {
          return new ArrayBuffer(0);
        }

        const packPath = `data/${search.filename !== '' ? search.filename + '/' : ''}pak${j}.pak`;
        const fd = fs.openSync(packPath, 'r');

        try {
          const buffer = Buffer.alloc(file.filelen);
          fs.readSync(fd, buffer, 0, file.filelen, file.filepos);

          Sys.Print(`PackFile: ${packPath} : ${filename}\n`);
          return new Uint8Array(buffer).buffer;
        } finally {
          fs.closeSync(fd);
        }
      }
    }

    // Search in the filesystem
    if (fs.existsSync(`data/${netpath}`)) {
      const buffer = fs.readFileSync(`data/${netpath}`);
      Sys.Print(`FindFile: ${netpath}\n`);
      return new Uint8Array(buffer).buffer;
    }
  }

  Sys.Print(`FindFile: can't find ${filename}\n`);
};

COM.LoadFileAsync = async () => {
  throw new Error('NOT IMPLEMENTED');
}; // TODO

COM.Shutdown = function() {
};

/**
 * Loads and parses a pack file.
 * @param {string} packfile - The path to the pack file.
 * @return {Array<Object> | undefined} - The parsed pack file entries or undefined if the file doesn't exist.
 */
COM.LoadPackFile = function(packfile) {
  if (!fs.existsSync(`data/${packfile}`)) {
    return;
  }

  const fd = fs.openSync(`data/${packfile}`, 'r');

  try {
    // Read and validate the pack file header
    const headerBuffer = Buffer.alloc(12);
    fs.readSync(fd, headerBuffer, 0, 12, 0);

    const header = new DataView(new Uint8Array(headerBuffer).buffer);
    if (header.getUint32(0, true) !== 0x4b434150) { // "PACK" magic number
      Sys.Error(`${packfile} is not a packfile`);
    }

    const dirofs = header.getUint32(4, true);
    const dirlen = header.getUint32(8, true);
    const numpackfiles = dirlen >> 6; // Each entry is 64 bytes

    if (numpackfiles !== 339) {
      COM.modified = true;
    }

    const pack = [];

    if (numpackfiles > 0) {
      const infoBuffer = Buffer.alloc(dirlen);
      fs.readSync(fd, infoBuffer, 0, dirlen, dirofs);

      const uint8ArrayInfo = new Uint8Array(infoBuffer);
      if (CRC.Block(uint8ArrayInfo) !== 32981) {
        COM.modified = true;
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
    fs.closeSync(fd);
  }
};

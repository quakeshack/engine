// this replaces a few functions on COM, so make sure to require this after requiring COM.js

const fs = require('fs');

COM.LoadFile = function(filename) {
  filename = filename.toLowerCase();

  let i; let j; let k; let search; let netpath; let pak; let file; let data;

  for (i = COM.searchpaths.length - 1; i >= 0; --i) {
    search = COM.searchpaths[i];
    netpath = search.filename !== '' ? search.filename + '/' + filename : filename;

    for (j = search.pack.length - 1; j >= 0; --j) {
      pak = search.pack[j];
      for (k = 0; k < pak.length; ++k) {
        file = pak[k];
        if (file.name !== filename) {
          continue;
        }
        if (file.filelen === 0) {
          return new ArrayBuffer(0);
        }

        const fd = fs.openSync(search.filename + 'Quake1Game' + j + '.pak', 'r');

        try {
          const buffer = Buffer.alloc(file.filelen);
          fs.readSync(fd, buffer, 0, file.filelen, file.filepos);
          const uint8Array = new Uint8Array(buffer);

          Sys.Print('PackFile: ' + search.filename + 'Quake1Game' + j + '.pak : ' + filename + '\n');

          return uint8Array.buffer;
        } finally {
          fs.closeSync(fd);
        }
      }
    }

    if (fs.existsSync(netpath)) {
      const buffer = fs.readFileSync(netpath);
      const uint8Array = new Uint8Array(buffer);

      Sys.Print('FindFile: ' + netpath + '\n');

      return uint8Array;
    }
  }
  Sys.Print('FindFile: can\'t find ' + filename + '\n');
};


COM.LoadPackFile = function(packfile) {
  // const xhr = new XMLHttpRequest();
  // xhr.overrideMimeType('text/plain; charset=x-user-defined');
  // xhr.open('GET', packfile, false);
  // xhr.setRequestHeader('Range', 'bytes=0-11');
  // xhr.send();
  // if ((xhr.status <= 199) || (xhr.status >= 300) || (xhr.responseText.length !== 12)) {
  //   return;
  // }

  if (!fs.existsSync(packfile)) {
    return;
  }

  const fd = fs.openSync(packfile, 'r');

  try {
    const headerBuffer = Buffer.alloc(12);
    fs.readSync(fd, headerBuffer, 0, 12, 0);

    const header = new DataView(new Uint8Array(headerBuffer).buffer);

    if (header.getUint32(0, true) !== 0x4b434150) {
      Sys.Error(packfile + ' is not a packfile');
    }

    const dirofs = header.getUint32(4, true);
    const dirlen = header.getUint32(8, true);
    const numpackfiles = dirlen >> 6;
    if (numpackfiles !== 339) {
      COM.modified = true;
    }
    const pack = [];
    if (numpackfiles !== 0) {
      const info = Buffer.alloc(dirlen);
      fs.readSync(fd, info, 0, dirlen, dirofs);
      const uint8ArrayInfo = new Uint8Array(info);
      if (CRC.Block(new Uint8Array(info)) !== 32981) {
        COM.modified = true;
      }
      const dv = new DataView(uint8ArrayInfo.buffer);
      for (let i = 0; i < numpackfiles; ++i) {
        pack.push({
          name: Q.memstr(new Uint8Array(uint8ArrayInfo.buffer, i << 6, 56)).toLowerCase(),
          filepos: dv.getUint32((i << 6) + 56, true),
          filelen: dv.getUint32((i << 6) + 60, true),
        });
      }
    }
    Con.Print('Added packfile ' + packfile + ' (' + numpackfiles + ' files)\n');

    return pack;
  } finally {
    fs.closeSync(fd);
  }
};

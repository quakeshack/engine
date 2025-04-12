/* global Con, COM, Cmd, Cvar, Q, Sys, Draw, CRC */

// eslint-disable-next-line no-global-assign
COM = {};

COM.argv = [];

COM.standard_quake = true;

COM.DefaultExtension = function(path, extension) {
  let i; let src;
  for (i = path.length - 1; i >= 0; --i) {
    src = path.charCodeAt(i);
    if (src === 47) {
      break;
    }
    if (src === 46) {
      return path;
    }
  }
  return path + extension;
};

COM.Parse = function(data) {
  COM.token = '';
  let i = 0; let c;
  if (data.length === 0) {
    return null;
  }

  let skipwhite = true;
  for (;;) {
    if (skipwhite !== true) {
      break;
    }
    skipwhite = false;
    for (;;) {
      if (i >= data.length) {
        return;
      }
      c = data.charCodeAt(i);
      if (c > 32) {
        break;
      }
      ++i;
    }
    if ((c === 47) && (data.charCodeAt(i + 1) == 47)) {
      for (;;) {
        if ((i >= data.length) || (data.charCodeAt(i) === 10)) {
          break;
        }
        ++i;
      }
      skipwhite = true;
    }
  }

  if (c === 34) {
    ++i;
    for (;;) {
      c = data.charCodeAt(i);
      ++i;
      if ((i >= data.length) || (c === 34)) {
        return data.substring(i);
      }
      COM.token += String.fromCharCode(c);
    }
  }

  for (;;) {
    if ((i >= data.length) || (c <= 32)) {
      break;
    }
    COM.token += String.fromCharCode(c);
    ++i;
    c = data.charCodeAt(i);
  }

  return data.substring(i);
};

COM.CheckParm = function(parm) {
  for (let i = 1; i < COM.argv.length; ++i) {
    if (COM.argv[i] === parm) {
      return i;
    }
  }

  return null;
};

COM.GetParm = function(parm) {
  for (let i = 1; i < COM.argv.length; ++i) {
    if (COM.argv[i] === parm) {
      return COM.argv[i + 1] || null;
    }
  }

  return null;
};

COM.CheckRegistered = async function() {
  const h = await COM.LoadFileAsync('gfx/pop.lmp');
  if (h === null) {
    Con.PrintSuccess('Playing shareware version.\n');
    return false;
  }
  const check = new Uint8Array(h);
  const pop = [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x66, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x66, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x66, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x67, 0x00, 0x00,
    0x00, 0x00, 0x66, 0x65, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x65, 0x66, 0x00,
    0x00, 0x63, 0x65, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x61, 0x65, 0x63,
    0x00, 0x64, 0x65, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x61, 0x65, 0x64,
    0x00, 0x64, 0x65, 0x64, 0x00, 0x00, 0x64, 0x69, 0x69, 0x69, 0x64, 0x00, 0x00, 0x64, 0x65, 0x64,
    0x00, 0x63, 0x65, 0x68, 0x62, 0x00, 0x00, 0x64, 0x68, 0x64, 0x00, 0x00, 0x62, 0x68, 0x65, 0x63,
    0x00, 0x00, 0x65, 0x67, 0x69, 0x63, 0x00, 0x64, 0x67, 0x64, 0x00, 0x63, 0x69, 0x67, 0x65, 0x00,
    0x00, 0x00, 0x62, 0x66, 0x67, 0x69, 0x6A, 0x68, 0x67, 0x68, 0x6A, 0x69, 0x67, 0x66, 0x62, 0x00,
    0x00, 0x00, 0x00, 0x62, 0x65, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x65, 0x62, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x62, 0x63, 0x64, 0x66, 0x64, 0x63, 0x62, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x62, 0x66, 0x62, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x61, 0x66, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x65, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ];
  for (let i = 0; i < 256; ++i) {
    if (check[i] !== pop[i]) {
      Sys.Error('Corrupted data file.');
    }
  }
  COM.registered.set(true);
  Con.PrintSuccess('Playing registered version.\n');
  return true;
};

COM.InitArgv = function(argv) {
  COM.cmdline = (argv.join(' ') + ' ').substring(0, 256);
  let i;
  for (i = 0; i < argv.length; ++i) {
    COM.argv[i] = argv[i];
  }
  if (COM.CheckParm('-safe')) {
    COM.argv[COM.argv.length] = '-nosound';
    COM.argv[COM.argv.length] = '-nocdaudio';
    COM.argv[COM.argv.length] = '-nomouse';
  }
  if (COM.CheckParm('-rogue')) {
    COM.rogue = true;
    COM.standard_quake = false;
  } else if (COM.CheckParm('-hipnotic')) {
    COM.hipnotic = true;
    COM.standard_quake = false;
  }
};

COM.Init = async function() {
  try {
    if ((document.location.protocol !== 'http:') && (document.location.protocol !== 'https:')) {
      Sys.Error('Protocol is ' + document.location.protocol + ', not http: or https:');
    }
  // eslint-disable-next-line no-unused-vars
  } catch (e) { /* empty */ }

  const swaptest = new ArrayBuffer(2);
  const swaptestview = new Uint8Array(swaptest);
  swaptestview[0] = 1;
  swaptestview[1] = 0;
  if ((new Uint16Array(swaptest))[0] === 1) { // CR: I’m pretty sure this is not useful in JavaScript at all
    COM.LittleLong = (function(l) {
      return l;
    });
  } else {
    COM.LittleLong = (function(l) {
      return (l >>> 24) + ((l & 0xff0000) >>> 8) + (((l & 0xff00) << 8) >>> 0) + ((l << 24) >>> 0);
    });
  }

  COM._abortController = new AbortController();

  COM.registered = new Cvar('registered', '0', Cvar.FLAG.READONLY, 'Set to 1, when not playing shareware.');
  COM.cmdline = new Cvar('cmdline', COM.cmdline, Cvar.FLAG.READONLY | Cvar.FLAG.SERVER, 'Command line used to start the game.');

  Cmd.AddCommand('path', COM.Path_f);

  await COM.InitFilesystem();
  await COM.CheckRegistered();
};

COM.Shutdown = function() {
  Sys.Print(`COM.Shutdown: signaling outstanding promises to abort\n`);

  COM._abortController.abort('COM.Shutdown');
};

COM.searchpaths = [];

COM.Path_f = function() {
  Con.Print('Current search path:\n');
  let i = COM.searchpaths.length; let j; let s;
  for (i = COM.searchpaths.length - 1; i >= 0; --i) {
    s = COM.searchpaths[i];
    for (j = s.pack.length - 1; j >= 0; --j) {
      Con.Print(s.filename + 'pak' + j + '.pak (' + s.pack[j].length + ' files)\n');
    }
    Con.Print(s.filename + '\n');
  }
};

COM.WriteFile = function(filename, data, len) {
  filename = filename.toLowerCase();
  const dest = [];
  for (let i = 0; i < len; ++i) {
    dest[i] = String.fromCharCode(data[i]);
  }
  try {
    localStorage.setItem('Quake.' + COM.searchpaths[COM.searchpaths.length - 1].filename + '/' + filename, dest.join(''));
  } catch (e) {
    Sys.Print('COM.WriteFile: failed on ' + filename + ', ' + e.message + '\n');
    return false;
  }
  Sys.Print('COM.WriteFile: ' + filename + '\n');
  return true;
};

COM.WriteTextFile = function(filename, data) {
  filename = filename.toLowerCase();
  try {
    localStorage.setItem('Quake.' + COM.searchpaths[COM.searchpaths.length - 1].filename + '/' + filename, data);
  } catch (e) {
    Sys.Print('COM.WriteTextFile: failed on ' + filename + ', ' + e.message + '\n');
    return false;
  }
  Sys.Print('COM.WriteTextFile: ' + filename + '\n');
  return true;
};

/**
 * @param {string} filename virtual filename
 * @returns {ArrayBuffer} binary content
 * @deprecated use async version instead
 */
COM.LoadFile = function(filename) {
  filename = filename.toLowerCase();

  const xhr = new XMLHttpRequest();
  // The Quake engine often wants data as "text/plain; charset=x-user-defined".
  xhr.overrideMimeType('text/plain; charset=x-user-defined');

  Draw.BeginDisc();

  // Traverse the search paths from last to first
  for (let i = COM.searchpaths.length - 1; i >= 0; i--) {
    const search = COM.searchpaths[i];
    const netpath = search.filename + '/' + filename;

    // 1) Try to load from localStorage first
    const localData = localStorage.getItem(`Quake.${netpath}`);
    if (localData !== null) {
      // Sys.Print(`COM.LoadFile: ${netpath}\n`);
      Draw.EndDisc();
      return Q.strmem(localData);
    }

    // // 2) Search through any PAK files in this search path
    // for (let j = search.pack.length - 1; j >= 0; j--) {
    //   const pak = search.pack[j];

    //   for (let k = 0; k < pak.length; k++) {
    //     const file = pak[k];

    //     // File name must match exactly
    //     if (file.name !== filename) continue;

    //     // Empty file?
    //     if (file.filelen === 0) {
    //       Draw.EndDisc();
    //       return new ArrayBuffer(0);
    //     }

    //     // Perform a synchronous XHR for the appropriate byte range
    //     const prefix = (search.filename !== '') ? `${search.filename}/` : '';
    //     xhr.open('GET', `data/${prefix}pak${j}.pak`, false);
    //     xhr.setRequestHeader(
    //         'Range',
    //         `bytes=${file.filepos}-${file.filepos + file.filelen - 1}`,
    //     );
    //     try {
    //       xhr.send();
    //     } catch (err) {
    //       Sys.Error(`COM.LoadFile: failed to load ${filename} from pak, ${err.message}`);
    //     }

    //     // Check status and length
    //     if (
    //       xhr.status >= 200 &&
    //       xhr.status <= 299 &&
    //       xhr.responseText.length === file.filelen
    //     ) {
    //       Sys.Print(`COM.LoadFile: ${prefix}pak${j}.pak : ${filename}\n`);
    //       Draw.EndDisc();
    //       return Q.strmem(xhr.responseText);
    //     }

    //     // If we got here, it means a failed range request; break out of the pak loop
    //     break;
    //   }
    // }

    // 3) Fallback: try plain files on the filesystem (in data/)
    xhr.open('GET', `quakefs/${filename}`, false);
    try {
      xhr.send();
    } catch (err) {
      Sys.Error(`COM.LoadFile: failed to load ${filename}, ${err.message}`);
    }

    if (xhr.status >= 200 && xhr.status <= 299) {
      Sys.Print(`COM.LoadFile: ${filename}\n`);
      Draw.EndDisc();
      return Q.strmem(xhr.responseText);
    }
  }

  // If we exhaust all search paths, file is not found
  Sys.Print(`COM.LoadFile: can't find ${filename}\n`);
  Draw.EndDisc();
  return null;
};

/**
 * @param {string} filename virtual filename
 * @returns {Promise<ArrayBuffer>} binary content
 */
COM.LoadFileAsync = async function(filename) {
  filename = filename.toLowerCase();

  Draw.BeginDisc();

  // Traverse the search paths from last to first
  for (let i = COM.searchpaths.length - 1; i >= 0; i--) {
    const search = COM.searchpaths[i];
    const netpath = search.filename + '/' + filename;

    // 1) Try localStorage first (instantaneous)
    const localData = localStorage.getItem(`Quake.${netpath}`);
    if (localData !== null) {
      Sys.Print(`COM.LoadFileAsync: ${netpath}\n`);
      Draw.EndDisc();
      return Q.strmem(localData);
    }

    // // 2) Check files inside each PAK
    // for (let j = search.pack.length - 1; j >= 0; j--) {
    //   const pak = search.pack[j];

    //   for (let k = 0; k < pak.length; k++) {
    //     const file = pak[k];
    //     if (file.name !== filename) {
    //       continue;
    //     }

    //     // Empty file?
    //     if (file.filelen === 0) {
    //       Draw.EndDisc();
    //       return new ArrayBuffer(0);
    //     }

    //     const prefix = (search.filename !== '') ? `${search.filename}/` : '';
    //     const pakUrl = `data/${prefix}pak${j}.pak`;
    //     const rangeHeader = `bytes=${file.filepos}-${file.filepos + file.filelen - 1}`;

    //     try {
    //       // Attempt ranged fetch
    //       const response = await fetch(pakUrl, {
    //         headers: {Range: rangeHeader},
    //         signal: COM._abortController.signal,
    //       });

    //       // If the server honors the Range request, check the data
    //       if (response.ok) {
    //         const responseBuffer = await response.arrayBuffer();

    //         // Validate length
    //         if (responseBuffer.byteLength === file.filelen) {
    //           Sys.Print(`COM.LoadFileAsync: ${prefix}pak${j}.pak : ${filename}\n`);
    //           Draw.EndDisc();
    //           return responseBuffer;
    //         } else {
    //           Sys.Print(`COM.LoadFileAsync: ${prefix}pak${j}.pak : ${filename} invalid length received\n`);
    //         }
    //       }
    //     } catch (err) {
    //       // Possibly log error, but continue gracefully
    //       console.error(err);
    //     }

    //     // If the fetch or length check fails, break out of the PAK loop
    //     break;
    //   }
    // }

    // 3) Fallback: try direct file
    try {
      const fallbackUrl = `quakefs/${filename}`;
      const directResponse = await fetch(fallbackUrl, {
        signal: COM._abortController.signal,
      });

      if (directResponse.ok) {
        const data = await directResponse.arrayBuffer();
        Sys.Print(`COM.LoadFileAsync: ${filename}\n`);
        Draw.EndDisc();
        return data;
      }
    } catch (err) {
      // If direct fetch failed, continue searching
      console.error(err);
    }
  }

  // If we exhaust all search paths, file is not found
  Sys.Print(`COM.LoadFileAsync: can't find ${filename}\n`);
  Draw.EndDisc();
  return null;
};

COM.LoadTextFile = function(filename) {
  const buf = COM.LoadFile(filename);
  if (buf == null) {
    return null;
  }
  const bufview = new Uint8Array(buf);
  const f = [];
  let i;
  for (i = 0; i < bufview.length; ++i) {
    if (bufview[i] !== 13) {
      f[f.length] = String.fromCharCode(bufview[i]);
    }
  }
  return f.join('');
};

COM.LoadTextFileAsync = async function(filename) {
  const buf = await COM.LoadFileAsync(filename);
  if (buf == null) {
    return null;
  }
  const bufview = new Uint8Array(buf);
  const f = [];
  for (let i = 0; i < bufview.length; ++i) {
    if (bufview[i] !== 13) {
      f[f.length] = String.fromCharCode(bufview[i]);
    }
  }
  return f.join('');
};

COM.LoadPackFile = async function (packfile) {
  // Try fetching the header (first 12 bytes).
  let headerResponse;
  try {
    headerResponse = await fetch(`data/${packfile}`, {
      headers: { Range: 'bytes=0-11' }
    });
  } catch (err) {
    Sys.Error(`COM.LoadPackFile: failed to load ${packfile}, ${err.message}`);
    return null;
  }

  // If the response is not OK, or we didn't get exactly 12 bytes, bail out.
  if (!headerResponse.ok) {
    return null;
  }

  const headerBuffer = await headerResponse.arrayBuffer();
  if (headerBuffer.byteLength !== 12) {
    Sys.Error(`COM.LoadPackFile: expected 12-byte header, got ${headerBuffer.byteLength}`);
    return null;
  }

  // Parse the pack file header.
  const headerView = new DataView(headerBuffer);
  if (headerView.getUint32(0, true) !== 0x4b434150) { // 'PACK'
    Sys.Error(`${packfile} is not a packfile`);
    return null;
  }

  const dirofs = headerView.getUint32(4, true);
  const dirlen = headerView.getUint32(8, true);
  const numpackfiles = dirlen >> 6; // dirlen / 64

  if (numpackfiles !== 339) {
    COM.modified = true;
  }

  // If there are no files in the pack, just return an empty array.
  if (numpackfiles === 0) {
    Con.Print(`Added packfile ${packfile} (0 files)\n`);
    return [];
  }

  // Fetch directory entries using Range for the directory area.
  let dirResponse;
  try {
    dirResponse = await fetch(`data/${packfile}`, {
      headers: { Range: `bytes=${dirofs}-${dirofs + dirlen - 1}` }
    });
  } catch (err) {
    Sys.Error(`COM.LoadPackFile: failed to load directory of ${packfile}, ${err.message}`);
    return null;
  }

  if (!dirResponse.ok) {
    return null;
  }

  const dirBuffer = await dirResponse.arrayBuffer();
  if (dirBuffer.byteLength !== dirlen) {
    Sys.Error(
      `COM.LoadPackFile: expected ${dirlen} bytes for directory, got ${dirBuffer.byteLength}`
    );
    return null;
  }

  // Optional CRC check, assuming CRC.Block() still works on a Uint8Array:
  const dirUint8 = new Uint8Array(dirBuffer);
  if (CRC.Block(dirUint8) !== 32981) {
    COM.modified = true;
  }

  // Parse out the individual file entries in the pack directory.
  const dirView = new DataView(dirBuffer);
  const pack = [];
  for (let i = 0; i < numpackfiles; ++i) {
    // Each entry is 64 bytes total:
    //   - 56 bytes: file name (null-padded)
    //   - 4 bytes:  file position
    //   - 4 bytes:  file length

    // Convert the "filename" portion to string (using your Q.memstr if needed):
    const nameBytes = dirUint8.subarray(i * 64, i * 64 + 56);
    const name = Q.memstr(nameBytes).toLowerCase();

    const filepos = dirView.getUint32(i * 64 + 56, true);
    const filelen = dirView.getUint32(i * 64 + 60, true);

    pack.push({ name, filepos, filelen });
  }

  Con.Print(`Added packfile ${packfile} (${numpackfiles} files)\n`);
  return pack;
};

COM.AddGameDirectory = async function(dir) {
  const search = {filename: dir, pack: []};
  let pak; let i = 0;
  for (;;) {
    pak = await COM.LoadPackFile((dir !== '' ? dir + '/' : '') + 'pak' + i + '.pak');
    if (pak == null) {
      break;
    }
    search.pack[search.pack.length] = pak;
    ++i;
  }
  COM.searchpaths[COM.searchpaths.length] = search;
};

COM.InitFilesystem = async function() {
  let i; let search;

  i = COM.CheckParm('-basedir');
  if (i != null) {
    search = COM.argv[i + 1];
  }
  if (search != null) {
    await COM.AddGameDirectory(search);
  } else {
    await COM.AddGameDirectory('id1');
  }

  if (COM.rogue === true) {
    await COM.AddGameDirectory('rogue');
  } else if (COM.hipnotic === true) {
    await COM.AddGameDirectory('hipnotic');
  }

  i = COM.CheckParm('-game');
  if (i != null) {
    search = COM.argv[i + 1];
    if (search != null) {
      COM.modified = true;
      await COM.AddGameDirectory(search);
    }
  }

  COM.gamedir = [COM.searchpaths[COM.searchpaths.length - 1]];
};

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
    return;
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
  let i;
  for (i = 1; i < COM.argv.length; ++i) {
    if (COM.argv[i] === parm) {
      return i;
    }
  }

  return null;
};

COM.GetParm = function(parm) {
  let i;
  for (i = 1; i < COM.argv.length; ++i) {
    if (COM.argv[i] === parm) {
      return COM.argv[i + 1] || null;
    }
  }

  return null;
};

COM.CheckRegistered = function() {
  const h = COM.LoadFile('gfx/pop.lmp');
  if (h == null) {
    Con.Print('Playing shareware version.\n');
    return;
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
  let i;
  for (i = 0; i < 256; ++i) {
    if (check[i] !== pop[i]) {
      Sys.Error('Corrupted data file.');
    }
  }
  Cvar.Set('registered', '1');
  Con.Print('Playing registered version.\n');
};

COM.InitArgv = function(argv) {
  COM.cmdline = (argv.join(' ') + ' ').substring(0, 256);
  let i;
  for (i = 0; i < argv.length; ++i) {
    COM.argv[i] = argv[i];
  }
  if (COM.CheckParm('-safe') != null) {
    COM.argv[COM.argv.length] = '-nosound';
    COM.argv[COM.argv.length] = '-nocdaudio';
    COM.argv[COM.argv.length] = '-nomouse';
  }
  if (COM.CheckParm('-rogue') != null) {
    COM.rogue = true;
    COM.standard_quake = false;
  } else if (COM.CheckParm('-hipnotic') != null) {
    COM.hipnotic = true;
    COM.standard_quake = false;
  }
};

COM.Init = function() {
  try {
    if ((document.location.protocol !== 'http:') && (document.location.protocol !== 'https:')) {
      Sys.Error('Protocol is ' + document.location.protocol + ', not http: or https:');
    }
  } catch (e) {
    Sys.Print(`COM.Init: document.location check failed (${e.message}), assuming dedicated environment`);
  }

  const swaptest = new ArrayBuffer(2);
  const swaptestview = new Uint8Array(swaptest);
  swaptestview[0] = 1;
  swaptestview[1] = 0;
  if ((new Uint16Array(swaptest))[0] === 1) {
    COM.LittleLong = (function(l) {
      return l;
    });
  } else {
    COM.LittleLong = (function(l) {
      return (l >>> 24) + ((l & 0xff0000) >>> 8) + (((l & 0xff00) << 8) >>> 0) + ((l << 24) >>> 0);
    });
  }

  COM.registered = Cvar.RegisterVariable('registered', '0');
  Cvar.RegisterVariable('cmdline', COM.cmdline, false, true);
  Cmd.AddCommand('path', COM.Path_f);
  COM.InitFilesystem();
  COM.CheckRegistered();
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
  const dest = []; let i;
  for (i = 0; i < len; ++i) {
    dest[i] = String.fromCharCode(data[i]);
  }
  try {
    localStorage.setItem('Quake.' + COM.searchpaths[COM.searchpaths.length - 1].filename + '/' + filename, dest.join(''));
  } catch (e) {
    Sys.Print('COM.WriteFile: failed on ' + filename + ', ' + e.message + '\n');
    return;
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
    return;
  }
  Sys.Print('COM.WriteTextFile: ' + filename + '\n');
  return true;
};

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
      Sys.Print(`COM.LoadFile: ${netpath}\n`);
      Draw.EndDisc();
      return Q.strmem(localData);
    }

    // 2) Search through any PAK files in this search path
    for (let j = search.pack.length - 1; j >= 0; j--) {
      const pak = search.pack[j];

      for (let k = 0; k < pak.length; k++) {
        const file = pak[k];

        // File name must match exactly
        if (file.name !== filename) continue;

        // Empty file?
        if (file.filelen === 0) {
          Draw.EndDisc();
          return new ArrayBuffer(0);
        }

        // Perform a synchronous XHR for the appropriate byte range
        const prefix = (search.filename !== '') ? `${search.filename}/` : '';
        xhr.open('GET', `data/${prefix}pak${j}.pak`, false);
        xhr.setRequestHeader(
            'Range',
            `bytes=${file.filepos}-${file.filepos + file.filelen - 1}`,
        );
        try {
          xhr.send();
        } catch (err) {
          Sys.Error(`COM.LoadFile: failed to load ${filename} from pak, ${err.message}`);
        }

        // Check status and length
        if (
          xhr.status >= 200 &&
          xhr.status <= 299 &&
          xhr.responseText.length === file.filelen
        ) {
          Sys.Print(`COM.LoadFile: ${prefix}pak${j}.pak : ${filename}\n`);
          Draw.EndDisc();
          return Q.strmem(xhr.responseText);
        }

        // If we got here, it means a failed range request; break out of the pak loop
        break;
      }
    }

    // 3) Fallback: try plain files on the filesystem (in data/)
    xhr.open('GET', `data/${netpath}`, false);
    try {
      xhr.send();
    } catch (err) {
      Sys.Error(`COM.LoadFile: failed to load ${filename}, ${err.message}`);
    }

    if (xhr.status >= 200 && xhr.status <= 299) {
      Sys.Print(`COM.LoadFile: ${netpath}\n`);
      Draw.EndDisc();
      return Q.strmem(xhr.responseText);
    }
  }

  // If we exhaust all search paths, file is not found
  Sys.Print(`COM.LoadFile: can't find ${filename}\n`);
  Draw.EndDisc();
  return null;
};

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

    // 2) Check files inside each PAK
    for (let j = search.pack.length - 1; j >= 0; j--) {
      const pak = search.pack[j];

      for (let k = 0; k < pak.length; k++) {
        const file = pak[k];
        if (file.name !== filename) {
          continue;
        }

        // Empty file?
        if (file.filelen === 0) {
          Draw.EndDisc();
          return new ArrayBuffer(0);
        }

        const prefix = (search.filename !== '') ? `${search.filename}/` : '';
        const pakUrl = `data/${prefix}pak${j}.pak`;
        const rangeHeader = `bytes=${file.filepos}-${file.filepos + file.filelen - 1}`;

        try {
          // Attempt ranged fetch
          const response = await fetch(pakUrl, {
            headers: {Range: rangeHeader},
          });

          // If the server honors the Range request, check the data
          if (response.ok) {
            const responseBuffer = await response.arrayBuffer();

            // Validate length
            if (responseBuffer.byteLength === file.filelen) {
              Sys.Print(`COM.LoadFileAsync: ${prefix}pak${j}.pak : ${filename}\n`);
              Draw.EndDisc();
              return responseBuffer;
            } else {
              Sys.Print(`COM.LoadFileAsync: ${prefix}pak${j}.pak : ${filename} invalid length received\n`);
            }
          }
        } catch (err) {
          // Possibly log error, but continue gracefully
          console.error(err);
        }

        // If the fetch or length check fails, break out of the PAK loop
        break;
      }
    }

    // 3) Fallback: try direct file
    try {
      const fallbackUrl = `data/${netpath}`;
      const directResponse = await fetch(fallbackUrl);

      if (directResponse.ok) {
        const textData = await directResponse.text();
        Sys.Print(`COM.LoadFileAsync: ${netpath}\n`);
        Draw.EndDisc();
        return Q.strmem(textData);
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
    return;
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

COM.LoadPackFile = function(packfile) {
  const xhr = new XMLHttpRequest();
  xhr.overrideMimeType('text/plain; charset=x-user-defined');
  xhr.open('GET', 'data/' + packfile, false);
  xhr.setRequestHeader('Range', 'bytes=0-11');
  try {
    xhr.send();
  } catch (err) {
    Sys.Error(`COM.LoadPackFile: failed to load ${packfile}, ${err.message}`);
  }
  if ((xhr.status <= 199) || (xhr.status >= 300) || (xhr.responseText.length !== 12)) {
    return;
  }
  const header = new DataView(Q.strmem(xhr.responseText));
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
    xhr.open('GET', 'data/' + packfile, false);
    xhr.setRequestHeader('Range', 'bytes=' + dirofs + '-' + (dirofs + dirlen - 1));
    try {
      xhr.send();
    } catch (err) {
      Sys.Error(`COM.LoadPackFile: failed to load ${packfile}, ${err.message}`);
    }
    if ((xhr.status <= 199) || (xhr.status >= 300) || (xhr.responseText.length !== dirlen)) {
      return;
    }
    const info = Q.strmem(xhr.responseText);
    if (CRC.Block(new Uint8Array(info)) !== 32981) {
      COM.modified = true;
    }
    let i;
    for (i = 0; i < numpackfiles; ++i) {
      pack[pack.length] = {
        name: Q.memstr(new Uint8Array(info, i << 6, 56)).toLowerCase(),
        filepos: (new DataView(info)).getUint32((i << 6) + 56, true),
        filelen: (new DataView(info)).getUint32((i << 6) + 60, true),
      };
    }
  }
  Con.Print('Added packfile ' + packfile + ' (' + numpackfiles + ' files)\n');
  return pack;
};

COM.AddGameDirectory = function(dir) {
  const search = {filename: dir, pack: []};
  let pak; let i = 0;
  for (;;) {
    pak = COM.LoadPackFile((dir !== '' ? dir + '/' : '') + 'pak' + i + '.pak');
    if (pak == null) {
      break;
    }
    search.pack[search.pack.length] = pak;
    ++i;
  }
  COM.searchpaths[COM.searchpaths.length] = search;
};

COM.InitFilesystem = function() {
  let i; let search;

  i = COM.CheckParm('-basedir');
  if (i != null) {
    search = COM.argv[i + 1];
  }
  if (search != null) {
    COM.AddGameDirectory(search);
  } else {
    COM.AddGameDirectory('id1');
  }

  if (COM.rogue === true) {
    COM.AddGameDirectory('rogue');
  } else if (COM.hipnotic === true) {
    COM.AddGameDirectory('hipnotic');
  }

  i = COM.CheckParm('-game');
  if (i != null) {
    search = COM.argv[i + 1];
    if (search != null) {
      COM.modified = true;
      COM.AddGameDirectory(search);
    }
  }

  COM.gamedir = [COM.searchpaths[COM.searchpaths.length - 1]];
};

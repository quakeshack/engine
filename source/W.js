/* global W, COM, Q, Sys */

// eslint-disable-next-line no-global-assign
W = {};

W.lumps = [];

W.LoadWadFile = async function(filename) {
  const base = await COM.LoadFileAsync(filename);

  if (base === null) {
    Sys.Error('W.LoadWadFile: couldn\'t load ' + filename);
  }

  const view = new DataView(base);
  if (view.getUint32(0, true) !== 0x32444157) {
    Sys.Error('Wad file ' + filename + ' doesn\'t have WAD2 id');
  }
  const numlumps = view.getUint32(4, true);
  let infotableofs = view.getUint32(8, true);
  let i; let size; let lump;
  for (i = 0; i < numlumps; ++i) {
    size = view.getUint32(infotableofs + 4, true);
    lump = new ArrayBuffer(size);
    (new Uint8Array(lump)).set(new Uint8Array(base, view.getUint32(infotableofs, true), size));
    W.lumps[Q.memstr(new Uint8Array(base, infotableofs + 16, 16)).toUpperCase()] = lump;
    infotableofs += 32;
  }
};

W.GetLumpName = function(name) {
  const lump = W.lumps[name];

  if (lump === undefined) {
    Sys.Error('W.GetLumpName: ' + name + ' not found');
  }

  return lump;
};

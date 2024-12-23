VID = {};

VID.d_8to24table = new Uint32Array(new ArrayBuffer(1024));

VID.SetPalette = function() {
  const palette = COM.LoadFile('gfx/palette.lmp');
  if (palette == null) {
    Sys.Error('Couldn\'t load gfx/palette.lmp');
  }
  const pal = new Uint8Array(palette);
  let i; let src = 0;
  for (i = 0; i < 256; ++i) {
    VID.d_8to24table[i] = pal[src] + (pal[src + 1] << 8) + (pal[src + 2] << 16);
    src += 3;
  }
};

VID.Init = function() {
  document.getElementById('progress').style.display = 'none';
  GL.Init();
  VID.SetPalette();
};

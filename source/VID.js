VID = {};

// FIXME: make d_8to24table private, expose methods to do a 8-to-24
VID.d_8to24table = new Uint32Array(new ArrayBuffer(1024));
VID.filledColor = null;

VID.SetPalette = function() {
  const palette = COM.LoadFile('gfx/palette.lmp');
  if (palette == null) {
    Sys.Error('Couldn\'t load gfx/palette.lmp');
  }
  const pal = new Uint8Array(palette);
  for (let i = 0, src = 0; i < 256; ++i) {
    VID.d_8to24table[i] = pal[src++] + (pal[src++] << 8) + (pal[src++] << 16);

    if (VID.d_8to24table[i] === 0) {
      VID.filledColor = i;
    }
  }
};

VID.Init = function() {
  const $progress = document.getElementById('progress');
  $progress.parentElement.removeChild($progress);

  document.getElementById('console').style.display = 'none';

  GL.Init();
  VID.SetPalette();
};

VID.Shutdown = function() {
  GL.Shutdown();

  document.getElementById('console').style.display = 'block';
};

/* global VID, COM, GL, Sys */

// eslint-disable-next-line no-global-assign
VID = {};

// FIXME: make d_8to24table private, expose methods to do a 8-to-24
// TODO: rewrite existing code to use d_8to24table_u8 instead
VID.d_8to24table = new Uint32Array(new ArrayBuffer(1024));
VID.d_8to24table_u8 = new Uint8Array(768);
VID.filledColor = null;

VID.LoadPalette = async function() {
  const palette = await COM.LoadFileAsync('gfx/palette.lmp');

  if (palette === null) {
    Sys.Error('Couldn\'t load gfx/palette.lmp');
  }

  VID.d_8to24table_u8 = new Uint8Array(palette);
  for (let i = 0, src = 0; i < 256; i++) {
    const pal = VID.d_8to24table_u8;

    VID.d_8to24table[i] = pal[src++] + (pal[src++] << 8) + (pal[src++] << 16);

    if (VID.d_8to24table[i] === 0) {
      VID.filledColor = i;
    }
  }
};

/**
 * Helper function to convert indexed 8-bit data to RGBA format.
 * @param {Uint8Array} uint8data indexed 8-bit data, each byte is an index to the palette
 * @param {number} width width
 * @param {number} height height
 * @param {?Uint8Array} palette palette data, 256 colors, each color is 3 bytes (RGB), default is VID.d_8to24table_u8
 * @param {?number} transparentColor optional color index to treat as transparent (default is null, no transparency)
 * @returns {Uint8Array} RGBA data, each pixel is 4 bytes (R, G, B, A)
 */
VID.TranslateIndexToRGBA = function(uint8data, width, height, palette = VID.d_8to24table_u8, transparentColor = null) {
  const rgba = new Uint8Array(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    const colorIndex = uint8data[i];
    if (transparentColor !== null && colorIndex === transparentColor) {
      rgba[i * 4 + 0] = 0;
      rgba[i * 4 + 1] = 0;
      rgba[i * 4 + 2] = 0;
      rgba[i * 4 + 3] = 0;
      continue;
    }
    // lookup the color in the palette
    rgba[i * 4 + 0] = palette[colorIndex * 3];
    rgba[i * 4 + 1] = palette[colorIndex * 3 + 1];
    rgba[i * 4 + 2] = palette[colorIndex * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }

  return rgba;
};

VID.Init = async function() {
  const $progress = document.getElementById('progress');
  $progress.parentElement.removeChild($progress);

  document.getElementById('console').style.display = 'none';

  GL.Init();
  await VID.LoadPalette();
};

VID.Shutdown = function() {
  GL.Shutdown();

  document.getElementById('console').style.display = 'block';
};

// Lightmap atlas configuration
// LIGHTMAP_BLOCK_SIZE defines the width and height of each lightmap layer.
// The lightmap is stored as a TEXTURE_2D_ARRAY with 3 layers (R, G, B).
// Each layer is LIGHTMAP_BLOCK_SIZE x LIGHTMAP_BLOCK_SIZE pixels in RGBA8,
// where the 4 RGBA channels carry the 4 lightstyle intensities.
// LIGHTMAP_BLOCK_HEIGHT = LIGHTMAP_BLOCK_SIZE * 4 is the RGBA byte stride per row,
// used internally for CPU-side lightmap data indexing.
export const LIGHTMAP_BLOCK_SIZE = 2048;
export const LIGHTMAP_BLOCK_HEIGHT = LIGHTMAP_BLOCK_SIZE * 4; // RGBA byte stride per row


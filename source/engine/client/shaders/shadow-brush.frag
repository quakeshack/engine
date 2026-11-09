#version 300 es
precision highp float;

// No discard, so the GPU keeps rejecting hidden fragments before shading them (early depth test): a caster is either
// drawn whole or left out (ShadowMap._computeCasterFade()). Depth is written automatically by the rasterizer.
void main(void) {}

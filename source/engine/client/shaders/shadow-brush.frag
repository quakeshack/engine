#version 300 es
precision highp float;

uniform float uCasterFade;

#include "hash.glsl"

void main(void) {
  if (hash2D(gl_FragCoord.xy) > uCasterFade) {
    discard;
  }

  // Depth is written automatically by the rasterizer.
}

#version 300 es
precision highp float;
precision highp sampler2DArray;

uniform float uCasterFade;

#include "hash.glsl"
#include "sprite-texel.glsl"

in vec3 vTexCoord;
in vec2 vBlend;

void main(void) {
  // drops the pixels of an alpha tested sprite below a quarter alpha, so light passes through them
  vec4 texel = sampleSpriteTexel(vTexCoord, vBlend);

  // An alpha tested pixel that is left covers fully. A blended one covers by its alpha: the dither leaves that fraction
  // of the depth texels, and the receivers' PCF turns it into a partial shadow.
  float coverage = mix(1.0, texel.a, step(0.5, uBlendMode));

  if (hash2D(gl_FragCoord.xy) > uCasterFade * coverage) {
    discard;
  }

  // Depth is written automatically by the rasterizer.
}

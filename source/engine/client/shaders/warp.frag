#version 300 es
precision highp float;
precision highp sampler2D;

out vec4 fragColor;

uniform float uTime;
uniform sampler2D tTexture;

in vec2 vTexCoord;

void main(void) {
  // Apply warp effect to the texture coordinates.
  vec2 warpedCoord = vTexCoord + vec2(sin(vTexCoord.t * 15.70796 + uTime) * 0.003125,
                                      sin(vTexCoord.s * 9.817477 + uTime) * 0.005);

  vec2 texOffset = vec2(1.0 / 512.0, 1.0 / 512.0);

  // Apply a slight blur effect using a gaussian kernel.

  vec4 color = vec4(0.0);
  color += texture(tTexture, warpedCoord + vec2(-texOffset.x, -texOffset.y)) * 0.0625;
  color += texture(tTexture, warpedCoord + vec2(0.0,         -texOffset.y)) * 0.125;
  color += texture(tTexture, warpedCoord + vec2(texOffset.x,  -texOffset.y)) * 0.0625;
  color += texture(tTexture, warpedCoord + vec2(-texOffset.x, 0.0))         * 0.125;
  color += texture(tTexture, warpedCoord)                                   * 0.25;
  color += texture(tTexture, warpedCoord + vec2(texOffset.x,  0.0))         * 0.125;
  color += texture(tTexture, warpedCoord + vec2(-texOffset.x, texOffset.y)) * 0.0625;
  color += texture(tTexture, warpedCoord + vec2(0.0,          texOffset.y)) * 0.125;
  color += texture(tTexture, warpedCoord + vec2(texOffset.x,  texOffset.y)) * 0.0625;

  fragColor = color;
}

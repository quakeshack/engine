precision mediump float;

uniform float uTime;
uniform sampler2D tTexture;

varying vec2 vTexCoord;

void main(void) {
  // Apply warp effect to the texture coordinates.
  vec2 warpedCoord = vTexCoord + vec2(sin(vTexCoord.t * 15.70796 + uTime) * 0.003125,
                                      sin(vTexCoord.s * 9.817477 + uTime) * 0.005);

  vec2 texOffset = vec2(1.0 / 512.0, 1.0 / 512.0);

  // Apply a slight blur effect using a gaussian kernel.

  float kernel[9];
  kernel[0] = 0.0625; kernel[1] = 0.125;  kernel[2] = 0.0625;
  kernel[3] = 0.125;  kernel[4] = 0.25;   kernel[5] = 0.125;
  kernel[6] = 0.0625; kernel[7] = 0.125;  kernel[8] = 0.0625;

  vec4 color = vec4(0.0);

  for (int i = -1; i <= 1; i++) {
    for (int j = -1; j <= 1; j++) {
      color += texture2D(tTexture, warpedCoord + vec2(float(i) * texOffset.x, float(j) * texOffset.y)) * kernel[i + 1 + (j + 1) * 3];
    }
  }
  gl_FragColor = color;
}

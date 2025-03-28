precision mediump float;

uniform float uGamma;
uniform sampler2D tTexture;

varying vec2 vTexCoord;

void main(void) {
  gl_FragColor = texture2D(tTexture, vTexCoord);
  gl_FragColor.r = pow(gl_FragColor.r, uGamma);
  gl_FragColor.g = pow(gl_FragColor.g, uGamma);
  gl_FragColor.b = pow(gl_FragColor.b, uGamma);
}

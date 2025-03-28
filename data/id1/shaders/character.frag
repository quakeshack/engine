precision mediump float;

uniform sampler2D tTexture;

varying vec2 vTexCoord;

void main(void) {
  gl_FragColor = texture2D(tTexture, vTexCoord);
}

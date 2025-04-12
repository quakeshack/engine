precision mediump float;

uniform sampler2D tTexture;
uniform vec3 uColor;

varying vec2 vTexCoord;

void main(void) {
  gl_FragColor = texture2D(tTexture, vTexCoord) * vec4(uColor, 1.0);
}

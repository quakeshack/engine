precision mediump float;

uniform float uTime;
uniform sampler2D tTexture;

varying vec2 vTexCoord;

void main(void) {
  gl_FragColor = texture2D(tTexture, vTexCoord + vec2(sin(vTexCoord.t * 15.70796 + uTime) * 0.003125, sin(vTexCoord.s * 9.817477 + uTime) * 0.005));
}

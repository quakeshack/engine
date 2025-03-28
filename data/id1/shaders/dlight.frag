precision mediump float;

uniform float uGamma;

varying float vAlpha;

void main(void) {
  gl_FragColor = vec4(pow(1.0, uGamma), pow(0.5, uGamma), 0.0, vAlpha);
}

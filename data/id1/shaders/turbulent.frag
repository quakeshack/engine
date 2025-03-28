precision mediump float;

uniform float uGamma;
uniform float uTime;
uniform sampler2D tTexture;

varying vec2 vTexCoord;

void main(void) {
  gl_FragColor = vec4(texture2D(tTexture, vTexCoord + vec2(sin(vTexCoord.t * 3.141593 + uTime), sin(vTexCoord.s * 3.141593 + uTime)) * 0.125).rgb, 1.0);

  gl_FragColor.r = pow(gl_FragColor.r, uGamma);
  gl_FragColor.g = pow(gl_FragColor.g, uGamma);
  gl_FragColor.b = pow(gl_FragColor.b, uGamma);
}

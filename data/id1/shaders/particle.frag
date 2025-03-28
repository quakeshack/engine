precision mediump float;

uniform float uGamma;

varying vec2 vCoord;
varying vec3 vColor;

void main(void) {
  gl_FragColor = vec4(vColor, 1.0 - smoothstep(0.75, 1.0, length(vCoord)));

  gl_FragColor.r = pow(gl_FragColor.r, uGamma);
  gl_FragColor.g = pow(gl_FragColor.g, uGamma);
  gl_FragColor.b = pow(gl_FragColor.b, uGamma);
}

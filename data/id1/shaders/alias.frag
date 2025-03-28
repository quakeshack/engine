precision mediump float;

uniform float uGamma;
uniform float uAmbientLight;
uniform float uShadeLight;
uniform sampler2D tTexture;

varying vec2 vTexCoord;
varying float vLightDot;

void main(void){
  vec4 texture = texture2D(tTexture, vTexCoord);
  gl_FragColor = vec4(texture.rgb * mix(1.0, vLightDot * uShadeLight + uAmbientLight, texture.a), 1.0);
  gl_FragColor.r = pow(gl_FragColor.r, uGamma);
  gl_FragColor.g = pow(gl_FragColor.g, uGamma);
  gl_FragColor.b = pow(gl_FragColor.b, uGamma);
}

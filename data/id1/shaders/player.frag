precision mediump float;

uniform float uGamma;
uniform float uAmbientLight;
uniform float uShadeLight;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform sampler2D tTexture;
uniform sampler2D tPlayer;

varying vec2 vTexCoord;
varying float vLightDot;

void main(void) {
  vec4 texture = texture2D(tTexture, vTexCoord);
  vec4 player = texture2D(tPlayer, vTexCoord);

  gl_FragColor = vec4(mix(mix(texture.rgb, uTop * (1.0 / 191.25) * player.x, player.y), uBottom * (1.0 / 191.25) * player.z, player.w)* mix(1.0, vLightDot * uShadeLight + uAmbientLight, texture.a), 1.0);

  gl_FragColor.r = pow(gl_FragColor.r, uGamma);
  gl_FragColor.g = pow(gl_FragColor.g, uGamma);
  gl_FragColor.b = pow(gl_FragColor.b, uGamma);
}


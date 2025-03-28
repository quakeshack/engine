precision mediump float;

uniform vec3 uTop;
uniform vec3 uBottom;
uniform sampler2D tTexture;
uniform sampler2D tTrans;

varying vec2 vTexCoord;

void main(void) {
  vec4 texture = texture2D(tTexture, vTexCoord);
  vec4 trans = texture2D(tTrans, vTexCoord);

  gl_FragColor = vec4(mix(mix(texture.rgb, uTop * trans.x, trans.y), uBottom * trans.z, trans.w), texture.a);
}

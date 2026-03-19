#version 300 es
precision highp float;
precision highp sampler2D;

out vec4 fragColor;

uniform vec3 uTop;
uniform vec3 uBottom;
uniform sampler2D tTexture;
uniform sampler2D tTrans;

in vec2 vTexCoord;

void main(void) {
  vec4 texel = texture(tTexture, vTexCoord);
  vec4 trans = texture(tTrans, vTexCoord);

  fragColor = vec4(mix(mix(texel.rgb, uTop * trans.x, trans.y), uBottom * trans.z, trans.w), texel.a);
}

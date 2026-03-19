#version 300 es
precision highp float;
precision highp sampler2D;

out vec4 fragColor;

uniform sampler2D tTexture;
uniform vec2 uTexelOffset;

in vec2 vTexCoord;

void main(void) {
  vec3 color = texture(tTexture, vTexCoord).rgb * 0.1370228165;
  color += texture(tTexture, vTexCoord + uTexelOffset * 1.4584295168).rgb * 0.2393373249;
  color += texture(tTexture, vTexCoord - uTexelOffset * 1.4584295168).rgb * 0.2393373249;
  color += texture(tTexture, vTexCoord + uTexelOffset * 3.4039848067).rgb * 0.1394403032;
  color += texture(tTexture, vTexCoord - uTexelOffset * 3.4039848067).rgb * 0.1394403032;
  color += texture(tTexture, vTexCoord + uTexelOffset * 5.3518057801).rgb * 0.0527109636;
  color += texture(tTexture, vTexCoord - uTexelOffset * 5.3518057801).rgb * 0.0527109636;

  fragColor = vec4(color, 1.0);
}

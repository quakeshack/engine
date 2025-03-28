precision mediump float;

uniform float uGamma;
uniform float uAlpha;

uniform sampler2D tTextureA;
uniform sampler2D tTextureB;
uniform sampler2D tLightmap;
uniform sampler2D tDlight;
uniform sampler2D tLightStyleA;
uniform sampler2D tLightStyleB;

varying vec4 vTexCoord;
varying vec4 vLightStyle;

void main(void) {
  vec4 textureA = texture2D(tTextureA, vTexCoord.xy);
  vec4 textureB = texture2D(tTextureB, vTexCoord.xy);

  // interpolation
  vec4 texture = mix(textureA, textureB, uAlpha);
  vec4 lightstyle = mix(
    vec4(
      texture2D(tLightStyleA, vec2(vLightStyle.x, 0.0)).a,
      texture2D(tLightStyleA, vec2(vLightStyle.y, 0.0)).a,
      texture2D(tLightStyleA, vec2(vLightStyle.z, 0.0)).a,
      texture2D(tLightStyleA, vec2(vLightStyle.w, 0.0)).a
    ),
    vec4(
      texture2D(tLightStyleB, vec2(vLightStyle.x, 0.0)).a,
      texture2D(tLightStyleB, vec2(vLightStyle.y, 0.0)).a,
      texture2D(tLightStyleB, vec2(vLightStyle.z, 0.0)).a,
      texture2D(tLightStyleB, vec2(vLightStyle.w, 0.0)).a
    ),
    uAlpha
  );

  float d = dot(texture2D(tLightmap, vTexCoord.zw), lightstyle * 43.828125);

  gl_FragColor = vec4(
    texture.r * mix(1.0, d + texture2D(tDlight, vTexCoord.zw).r, texture.a),
    texture.g * mix(1.0, d + texture2D(tDlight, vTexCoord.zw).g, texture.a),
    texture.b * mix(1.0, d + texture2D(tDlight, vTexCoord.zw).b, texture.a),
    1.0
  );

  gl_FragColor.r = pow(gl_FragColor.r, uGamma);
  gl_FragColor.g = pow(gl_FragColor.g, uGamma);
  gl_FragColor.b = pow(gl_FragColor.b, uGamma);
}

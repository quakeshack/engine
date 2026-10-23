// The texels of a sprite's array texture hold premultiplied alpha, and a sprite is drawn with the blend function
// ONE, ONE_MINUS_SRC_ALPHA: the world's sprite program and the 2D one share what they read from the texture.
uniform sampler2DArray tTexture;
// 0: alpha tested, 1: alpha blended, 2: additive
uniform float uBlendMode;

// Reads the texel at texCoord (layer in z) and fades it into the same place of the layer in blend.x by blend.y. An alpha
// tested sprite drops pixels below a quarter alpha.
vec4 sampleSpriteTexel(vec3 texCoord, vec2 blend) {
  // premultiplied texels fade linearly into each other
  vec4 texel = mix(texture(tTexture, texCoord), texture(tTexture, vec3(texCoord.xy, blend.x)), blend.y);

  if (uBlendMode < 0.5 && texel.a < 0.25) discard;

  return texel;
}

// 1 for an additive sprite, which writes no alpha: what it covers stays and its color is added.
float spriteIsAdditive() {
  return step(1.5, uBlendMode);
}

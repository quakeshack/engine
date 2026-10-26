#version 300 es
precision highp float;

uniform mat4 uLightSpaceMatrix;

// the vertex of the sprite program, so the renderer streams the same quad for both
in vec3 aPosition;
// xy: texture coordinate, z: layer of the array texture
in vec3 aTexCoord;
// x: layer of the next image, y: how far to fade from this image to that one (0 shows only this image)
in vec2 aBlend;

out vec3 vTexCoord;
out vec2 vBlend;

void main(void) {
  // No normal bias, unlike shadow-alias-point: the bias keeps a caster from shadowing its own surface, and a sprite
  // receives no shadow. The point cubes take the rasterized depth of the face's perspective matrix as it is.
  gl_Position = uLightSpaceMatrix * vec4(aPosition, 1.0);

  vTexCoord = aTexCoord;
  vBlend = aBlend;
}

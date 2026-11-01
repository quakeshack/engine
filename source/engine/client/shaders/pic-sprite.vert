#version 300 es
precision highp float;

uniform mat4 uOrtho;

in vec2 aPosition;
// xy: texture coordinate, z: layer of the array texture
in vec3 aTexCoord;
// x: layer of the next image, y: how far to fade from this image to that one (0 shows only this image)
in vec2 aBlend;

out vec3 vTexCoord;
out vec2 vBlend;

void main(void) {
  gl_Position = uOrtho * vec4(aPosition, 0.0, 1.0);
  vTexCoord = aTexCoord;
  vBlend = aBlend;
}

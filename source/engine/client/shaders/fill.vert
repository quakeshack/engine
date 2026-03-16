#version 300 es
precision highp float;

uniform mat4 uOrtho;

in vec2 aPosition;
in vec4 aColor;

out vec4 vColor;

void main(void) {
  gl_Position = uOrtho * vec4(aPosition, 0.0, 1.0);
  vColor = aColor;
}

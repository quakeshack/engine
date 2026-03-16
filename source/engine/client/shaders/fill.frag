#version 300 es
precision highp float;

out vec4 fragColor;

in vec4 vColor;

void main(void) {
  fragColor = vColor;
}

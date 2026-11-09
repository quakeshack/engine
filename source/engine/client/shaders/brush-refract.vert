#version 300 es
precision highp float;
precision highp sampler2D;

#include "brush-vertex.glsl"

void main(void) {
  emitBrushVertex();
}

#version 300 es
precision highp float;

#include "brush-vertex.glsl"

void main(void) {
  emitBrushVertex();
}

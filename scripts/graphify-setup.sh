#!/usr/bin/env bash
# One-time, no-sudo bootstrap for graphify (https://graphify.net/), a local
# tree-sitter code-knowledge-graph CLI used to speed up agentic exploration of
# this repo. See .github/instructions/graphify-usage.instructions.md for how
# to actually use it once installed.
#
# This machine may not have pip or python3-venv available (installing the
# latter needs sudo). This script bootstraps pip via the official PyPA
# get-pip.py installer and installs graphify into a flat --target directory
# outside the repo, so nothing here touches system Python or git.
set -euo pipefail

INSTALL_DIR="${GRAPHIFY_INSTALL_DIR:-$HOME/.local/share/graphify-pylibs}"

if compgen -G "$INSTALL_DIR"/graphifyy-*.dist-info > /dev/null 2>&1; then
  echo "graphify already installed in $INSTALL_DIR — skipping."
else
  mkdir -p "$INSTALL_DIR"
  TMP_GET_PIP="$(mktemp)"
  trap 'rm -f "$TMP_GET_PIP"' EXIT

  echo "Bootstrapping pip into $INSTALL_DIR ..."
  curl -fsSL https://bootstrap.pypa.io/get-pip.py -o "$TMP_GET_PIP"
  python3 "$TMP_GET_PIP" --target="$INSTALL_DIR" --no-warn-script-location

  echo "Installing graphifyy into $INSTALL_DIR ..."
  PYTHONPATH="$INSTALL_DIR" python3 "$INSTALL_DIR/bin/pip" install \
    --target="$INSTALL_DIR" --no-warn-script-location graphifyy
fi

cat <<EOF

graphify is ready. It has no bin/ launcher (pip --target doesn't generate
console-script wrappers), so invoke it as a module:

  PYTHONPATH="$INSTALL_DIR" python3 -m graphify <command>

For example, to refresh the graph for this repo's source/ tree:

  PYTHONPATH="$INSTALL_DIR" python3 -m graphify update source --no-cluster

See .github/instructions/graphify-usage.instructions.md for the full
command cheat-sheet and known caveats before trusting its output.
EOF

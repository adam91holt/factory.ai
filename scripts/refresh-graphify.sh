#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
OUT_DIR="$ROOT_DIR/graphify-out"
PUBLISH_DIR="$ROOT_DIR/docs/architecture/graphify"
GRAPHIFY_BIN="${GRAPHIFY_BIN:-graphify}"
LABEL_BACKEND="${GRAPHIFY_LABEL_BACKEND:-claude-cli}"
MAX_CONCURRENCY="${GRAPHIFY_MAX_CONCURRENCY:-1}"

if ! command -v "$GRAPHIFY_BIN" >/dev/null 2>&1; then
  printf 'graphify is required. Install with:\n  uv tool install "graphifyy[svg,leiden]==0.9.32"\n' >&2
  exit 1
fi
if ! command -v uv >/dev/null 2>&1; then
  printf 'uv is required for the reproducible SVG/GraphML export.\n' >&2
  exit 1
fi

mkdir -p "$PUBLISH_DIR"

extract_args=("$ROOT_DIR" --code-only --out "$ROOT_DIR")
if [[ "${GRAPHIFY_FORCE:-0}" == "1" ]]; then
  extract_args+=(--force)
fi
"$GRAPHIFY_BIN" extract "${extract_args[@]}"
"$GRAPHIFY_BIN" label "$ROOT_DIR" \
  --backend="$LABEL_BACKEND" \
  --max-concurrency="$MAX_CONCURRENCY"
"$GRAPHIFY_BIN" tree \
  --graph "$OUT_DIR/graph.json" \
  --output "$OUT_DIR/GRAPH_TREE.html" \
  --root "$ROOT_DIR" \
  --label 'The Software Factory'
"$GRAPHIFY_BIN" export callflow-html "$OUT_DIR" \
  --output "$OUT_DIR/factory-callflow.html"

ROOT_DIR="$ROOT_DIR" uv run --with 'graphifyy[svg,leiden]==0.9.32' python - <<'PY'
import json
import os
from pathlib import Path
from networkx.readwrite import json_graph
from graphify.export import to_graphml, to_svg

root = Path(os.environ["ROOT_DIR"])
out = root / "graphify-out"
data = json.loads((out / "graph.json").read_text(encoding="utf-8"))
try:
    graph = json_graph.node_link_graph(data, edges="links")
except TypeError:
    graph = json_graph.node_link_graph(data)

communities: dict[int, list[str]] = {}
for node_id, attrs in graph.nodes(data=True):
    community = attrs.get("community")
    if community is None:
        continue
    try:
        community_id = int(community)
    except (TypeError, ValueError):
        continue
    communities.setdefault(community_id, []).append(node_id)

labels_path = out / ".graphify_labels.json"
labels = {
    int(key): value
    for key, value in json.loads(labels_path.read_text(encoding="utf-8")).items()
}
to_graphml(graph, communities, str(out / "graph.graphml"))
to_svg(graph, communities, str(out / "graph.svg"), community_labels=labels)
PY

ROOT_DIR="$ROOT_DIR" uv run --with cairosvg python - <<'PY'
import os
from pathlib import Path
import cairosvg

root = Path(os.environ["ROOT_DIR"])
out = root / "graphify-out"
cairosvg.svg2png(
    url=str(out / "graph.svg"),
    write_to=str(out / "graph-preview.png"),
    output_width=2400,
    output_height=1800,
)
PY

for file in \
  GRAPH_REPORT.md \
  GRAPH_TREE.html \
  factory-callflow.html \
  graph.graphml \
  graph.html \
  graph.json \
  graph.svg \
  graph-preview.png \
  manifest.json; do
  cp "$OUT_DIR/$file" "$PUBLISH_DIR/$file"
done
cp "$OUT_DIR/.graphify_labels.json" "$PUBLISH_DIR/community-labels.json"

ROOT_DIR="$ROOT_DIR" PUBLISH_DIR="$PUBLISH_DIR" python3 - <<'PY'
import os
from pathlib import Path

root = os.environ["ROOT_DIR"]
publish = Path(os.environ["PUBLISH_DIR"])
for name in ("GRAPH_REPORT.md", "graph.html", "factory-callflow.html", "GRAPH_TREE.html"):
    path = publish / name
    text = path.read_text(encoding="utf-8")
    path.write_text(text.replace(root, "factory.ai"), encoding="utf-8")
PY

printf 'Graphify artifacts refreshed in %s\n' "$PUBLISH_DIR"

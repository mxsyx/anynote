/** Find a dependency cycle containing start, including indirect/type-only edges. */
export function dependencyCycle(graph, start) {
  const visited = new Set();
  function visit(node, path) {
    if (node === start && path.length) return [...path, node];
    if (visited.has(node)) return null;
    visited.add(node);
    for (const next of graph.get(node) ?? []) {
      const cycle = visit(next, [...path, node]);
      if (cycle) return cycle;
    }
    return null;
  }
  return visit(start, []);
}

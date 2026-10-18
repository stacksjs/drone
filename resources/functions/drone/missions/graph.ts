/** Shared bounded DAG accounting for versioned mission profiles. No vehicle policy lives here. */
export function missionGraphBudget(nodes: { id: string, durationMs: number, edges: string[] }[], start: string, maximumMs: number): number {
  const invalid = () => { throw new TypeError('Invalid mission graph') }
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 32 || !Number.isFinite(maximumMs) || maximumMs <= 0) invalid()
  const tasks = new Map<string, typeof nodes[number]>()
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || tasks.has(node.id) || !Number.isFinite(node.durationMs) || node.durationMs <= 0 || !Array.isArray(node.edges) || node.edges.length > 2 || node.edges.some(e => typeof e !== 'string')) invalid()
    tasks.set(node.id, node)
  }
  const visiting = new Set<string>(), visited = new Set<string>(), costs = new Map<string, number>()
  function cost(id: string): number {
    if (visiting.has(id)) return invalid()
    if (costs.has(id)) return costs.get(id)!
    const task = tasks.get(id)
    if (!task) return invalid()
    visiting.add(id); visited.add(id)
    const total = task.durationMs + Math.max(0, ...task.edges.map(cost))
    visiting.delete(id); costs.set(id, total)
    return total
  }
  const total = cost(start)
  if (visited.size !== tasks.size || total > maximumMs) invalid()
  return total
}

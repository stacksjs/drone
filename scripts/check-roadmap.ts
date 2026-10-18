import inventory from '../docs/roadmap/upstream-inventory.json'
import issues from '../docs/roadmap/issues.json'

const byKey = new Map(issues.map(issue => [issue.key, issue]))
if (byKey.size !== issues.length) throw new Error('Duplicate roadmap keys')
const visiting = new Set<string>()
const complete = new Set<string>()
function visit(key: string) {
  if (visiting.has(key)) throw new Error(`Roadmap dependency cycle: ${key}`)
  if (complete.has(key)) return
  const issue = byKey.get(key)
  if (!issue) throw new Error(`Missing work item: ${key}`)
  visiting.add(key)
  for (const blocker of issue.blockedBy) visit(blocker)
  visiting.delete(key)
  complete.add(key)
}
for (const key of byKey.keys()) visit(key)
let count = 0
for (const upstream of inventory.upstreams) {
  if (!/^[a-f\d]{40}$/.test(upstream.revision)) throw new Error('Unpinned upstream revision')
  const seen = new Set<string>()
  for (const entry of upstream.entries) {
    const issue = byKey.get(entry.roadmapKey)
    if (!issue || entry.issue !== issue.url || seen.has(entry.path)
      || !entry.source.includes(`/${upstream.revision}/${entry.path}`)
      || !/^[a-f\d]{40}$/.test(entry.treeSha)) throw new Error(`Unmapped or invalid inventory entry: ${entry.path}`)
    seen.add(entry.path)
    count++
  }
}
if (count !== 274) throw new Error('Update and review the documented inventory scope with any upstream refresh')
console.log(`${count} pinned upstream entries mapped to ${issues.length} acyclic implementation issues`)

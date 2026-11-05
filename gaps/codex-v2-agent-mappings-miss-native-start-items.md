# Codex v2 launch anchors are absent from lazy agent mappings and durable child facts

The actual pinned Codex and Codex OSS native child scenarios prove a child
rollout's own parent and a parent `SubAgentActivity` started item carrying the
original spawn call id. The direct child projection understands that item, but
`CodexAgentMappingCollector` accepts only the older `function_call_output`
child id. Current v2 outputs contain a task name, so `getAgentMappings` returns
no anchor. The SQL child source persists structural header proof without a
launch id, so its mapping fallback cannot restore one either.

This was exposed by extending the inference-free actual native scenario while
adding SQL mapping consumers. Structural child navigation remains correct;
inline tool-to-child mapping and its persistence need the next coordinated
Codex consumer slice. Reuse the already audited started-item semantics and
already-read parent records, join only children with their own scoped parent
proof, and preserve the nonblocking transcript contract. Do not add a separate
parent-body replay to SQL structural acquisition or mistake copied fork history
for proof. No provider version or protocol target change is needed.

Evidence is in ignored `tasks/session-relationships/slice-8-linear-native.log`:
both actual Codex variants returned `[]` for the proved call/child pair.

Found 2026-11-05 while qualifying durable SQL agent-mapping consumers.

# brain-mcp as a brain

This repository is registered as a brain against its own server, which is how the
push-to-index loop is exercised without putting any tenant's material in it.

## Claims

- The indexer rebuilds a brain in full on every push to its default branch, inside one transaction guarded by a per-brain advisory lock.
  <!-- authority: live | verified_at: 2026-08-31 | supersedes: 8eb428c6620d594e -->
- Writes from the MCP tools open a pull request and never merge.
- A claim with no authority marker is durable and is never chased for re-verification.

# Agent Guide for castloop

castloop hosts podcasts in the administrator's Cloudflare account. Administrators use the standalone CLI to edit and publish shows; listeners retrieve feeds and episodes.

## CodeGraph in Git worktrees
- The `.codegraph/` index is local and untracked; only `.codegraph/.gitignore` is tracked. Initialize each newly created worktree with `codegraph init -y` before agent work.
- Never symlink/copy the database from another checkout or query that checkout's index for code being edited here. Index contents and daemon files belong to their worktree.
- The index is removed with its worktree; no separate cleanup is needed.
# Agent Guide for castloop

castloop hosts podcasts in the administrator's Cloudflare account. Administrators use the standalone CLI to edit and publish shows; listeners retrieve feeds and episodes.

## CodeGraph in Git worktrees
- The `.codegraph/` index is local and untracked; only `.codegraph/.gitignore` is tracked. Initialize each newly created worktree with `codegraph init -y` before agent work.
- Never symlink/copy the database from another checkout or query that checkout's index for code being edited here. Index contents and daemon files belong to their worktree.
- The index is removed with its worktree; no separate cleanup is needed.

## Project documentation
- Keep `README.md` and `README_ja.md` at the repository root as user-facing entry points.
- Keep installation, deployment, operations and verification guides in `docs/`.
- The authoritative MVP design is `docs/designs/castloop-mvp.md`. Update it when an approved design decision changes; do not treat brainstorming notes or review reports as current specification.
- Put design reviews and Goldfish review reports in `docs/designs/reviews/`.
- Put EGM brainstorming, alternatives, decision history and other working notes in `docs/designs/working-notes/`. Preserve useful history, but label superseded proposals clearly and link to the authoritative design.
- When moving or adding documentation, update relative Markdown links and this guide so agents can find the current source of truth.

# Metadata editing workflow alternatives

* **Author:** Akira Shimosako
* **Date:** 2026-11-07
* **Status:** Option B selected for the MVP, with backup-and-pull conflict handling. Git/GitHub, automatic merging, and built-in diff are excluded. Earlier proposals below remain as discussion history; the final accepted section takes precedence.

## Problem

Reduce the chance that an administrator starts editing stale TOML, rather than relying only on a warning at upload. The user accepts a local hidden state file for ETags if useful, and is reconsidering synchronization because large MP3 files can be excluded.

The earlier rejection concerned full media synchronization and ambiguous deletion. It does not rule out metadata-only synchronization. Keep direct MP3 upload and R2-side promotion in every alternative. Source metadata validity, delivery state, and scheduled release remain separate concerns.

## Options

| Option | Authoritative metadata | Normal edit flow | Main tradeoff |
| --- | --- | --- | --- |
| A. Managed edit operation | R2 | Fetch current TOML, open editor, validate, apply | Smallest change; less convenient for editing many files together |
| B. Metadata-only synchronization | R2 | Synchronize workspace, edit TOML, inspect/apply synchronization plan | Familiar local tree; Castloop implements baseline/conflict rules |
| C. Actual Git workflow | A selected branch in a Git remote | Pull, edit, normalize/check, commit, push, deploy | Reuses history/diffs/conflicts; changes source ownership and adds Git/repository setup |

All command spellings below are proposals.

## A. Fetch before opening the editor

`castloop episode edit <id>` obtains current remote metadata before opening the configured editor. On successful editing, run the existing format/publication checks and update flow. Do not overwrite an already modified local file when fetching. Retain a baseline and use a conditional write so changes made while the editor was open are detected.

This directly addresses the stale starting point without a full synchronization engine. It can coexist with a metadata download/list operation. It does not offer Git history or whole-tree reconciliation, and users editing arbitrary old files outside this flow still need conflict checks.

## B. Synchronize TOML, not MP3

Preserve the show/episode directory structure in a local workspace. Synchronize TOML and directories; MP3 upload/download remains explicit. Decide separately whether small cover images participate. Exclude generated feeds, publication artifacts, credentials, and all MP3s from default workspace synchronization.

An illustrative flow is `castloop sync --pull`, editing, `castloop status`, then `castloop sync --push`. This provides the requested before/after workflow while making direction explicit. A bidirectional `castloop sync` can be added, but must show a reconciliation plan rather than silently guessing upload versus download.

Store per-file remote ETags and hashes of the downloaded baseline in a local hidden manifest such as `.castloop/state.json`. The ETag belongs to a particular remote installation/key; it is not a timestamp. Compare local content against its baseline and the current remote object against its recorded ETag:

| Since the last baseline | Proposed ordinary action |
| --- | --- |
| Only local changed | Validate, then upload with a remote condition |
| Only remote changed | Download, preserving unrelated local edits |
| Both changed differently | Report a conflict; do not silently overwrite either side |
| Neither changed | No transfer |
| No baseline exists | Inspect current remote/local content and ask where needed; absence of state is not proof the local file is current |

The user already permits explicit overwrite confirmation. Retain that path after showing the conflicting files/difference. A change during confirmation must not be silently overwritten. Baseline files should only advance after the corresponding transfer succeeds; resume a later sync without claiming cross-file atomicity.

Do not infer deletion of a remote show/episode from a missing local file. Use explicit delete commands for the MVP. Likewise, a remotely deleted entity with local edits is a conflict, not an invitation to recreate it. Do not delete a nonempty local folder containing unsynchronized media merely to match remote prefixes. These rules keep the earlier deletion concern manageable.

Parse all candidate upload TOML before performing the chosen batch. Missing publication fields still follow the agreed save-and-validation rules. The upload plan must expose public effects, including episode withdrawal and the existing show-stop confirmation, before applying them. Downloading metadata must not itself publish content.

A hidden manifest supports freshness and conflicts, not version history or automatic text merging. Implementing general Git-like merging is unnecessary for this option.

## C. Use Git for source metadata

Use a separate content repository with the show/episode TOML tree and optionally small artwork. MP3s and credentials remain outside the repository. Private is the straightforward starting point if unpublished titles/descriptions should not be visible; repository visibility does not determine the public MP3 delivery path.

The selected remote branch becomes the metadata authority. R2 management TOML is a deployed copy of that source; do not also let independent direct TOML updates become a competing authority. Public delivery and generated media facts remain in R2.

An illustrative flow:

```sh
git pull --ff-only
# Edit TOML. Upload an MP3 directly with Castloop when needed.
castloop prepare
castloop check
git add .
git commit -m "Prepare an episode"
git push
# Publish the selected commit through Castloop or a GitHub Actions workflow.
```

`prepare` would generate missing IDs/timezones locally before committing. Do not let CI silently fill authoritative episode fields only in R2, or create a bot-commit synchronization loop. Existing episode timezones remain unchanged as already agreed. Plain Git is an external tool dependency unless the product deliberately embeds it; do not add an embedded Git implementation by default.

Git provides commit history, diffs, and integration of remote changes; normal pushes reject non-fast-forward updates. It does not detect semantic mistakes such as copying old file contents into a fresh commit, and a successful push is not proof that R2 publication succeeded. See [Git pull](https://git-scm.com/docs/git-pull) and [non-fast-forward rejection](https://docs.github.com/en/get-started/using-git/dealing-with-non-fast-forward-errors).

GitHub Actions could run validation/build/deployment on push or an explicit release/manual event. It is optional: actual Git management does not require automatic publication on every push. Initial simplicity favors one selected commit and a deliberate Castloop apply step before adding CI automation. If automation is added, preserve show-stop approval through an explicit authorization step; a noninteractive job must not treat a false flag as approval. Deleting a file or reverting a commit must not implicitly bypass show/episode deletion rules.

Keep reservation execution in Cloudflare. GitHub scheduled workflows have a minimum five-minute interval and can be delayed; they cannot provide the accepted one-to-two-minute release target. [GitHub Actions events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

Workflow serialization is useful but does not itself solve the CLI-versus-Cron publication race or guarantee every commit is applied in order. Keep deployment generation/release ownership in the technical design. [Workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)

## Recommendation for discussion

For an MVP that remains self-contained around the administrator's Cloudflare account, B is the closest match to the user's proposed local editing workflow. Keep it metadata-only, use explicit pull/push directions first, store an ETag/baseline manifest locally, stop on conflicts, and keep remote deletion explicit. This is a limited reconciliation tool, not a new general version-control system.

If the intended administrators are comfortable with Git and a repository is an acceptable prerequisite, C deserves serious consideration: it can reduce custom difference/history logic in Castloop. Start with Git plus an explicit CLI deployment rather than making Actions mandatory. The important cost is changing the source of truth and ensuring generated episode fields are committed locally; it is not merely exchanging ETags for commit hashes.

A remains the least work if whole-tree editing is not essential. Do not implement all three workflows in the MVP. Select one source of truth and one ordinary publishing path, then preserve the already accepted validation, confirmation, scheduling, and direct-media rules within it.

## Follow-up: small conflict handling without a Git dependency

The user prefers avoiding a Git/GitHub prerequisite. The recommendation is therefore to develop option B with file-level conflict detection and manual resolution first. This is a proposed design, not a decision to implement automatic merging.

Keep the ETag and a content digest of the last synchronized revision per TOML in `.castloop/state.json`. Compare local content against that baseline and the current remote ETag against the saved ETag. Treat ETags as opaque revision tokens, not file hashes. No timestamps are needed to decide whether local work is safe to replace.

| Local since baseline | Remote since baseline | Proposed pull behavior |
| --- | --- | --- |
| Unchanged | Unchanged | Leave the file alone. |
| Changed | Unchanged | Preserve local edits; nothing needs downloading. |
| Unchanged | Changed | Download the new remote file and update the baseline. |
| Changed | Changed | Fetch the current remote text for comparison. If contents already match, accept that common revision; otherwise report a conflict and preserve the local file and old baseline. |

A local file without a recorded baseline must not be treated as clean. Download to an absent path, recognize identical contents after comparison, or ask for explicit reconciliation. A missing local file must not imply remote deletion. Remote deletion while local work exists also needs a conflict result, not silent data loss. Deletion of shows and episodes continues to use explicit operations.

For the user's example, editing an old local TOML and then running pull will preserve that local file. If R2 changed too, show its path as conflicting and save the fetched remote candidate separately under `.castloop/conflicts/` for inspection. Do not insert conflict markers into authoritative TOML or publish anything during pull. The administrator can edit the local file after comparing it to the candidate, then explicitly resolve against that fetched remote revision. A subsequent push must still use a conditional write tied to that revision so another intervening remote update is detected. Conflict detection and protection are the MVP requirement; automatic combination of edits is optional.

The comparison logic needs no merge library: content equality/digests and ETag comparisons suffice. The remaining Castloop work is remote I/O, conditional writes, safe local file/state updates, and explicit conflict outcomes. A text library does not replace those responsibilities or solve concurrent publication by the CLI and Cron.

Optional libraries:

- `diff` (jsdiff) supplies line differences and unified patch formatting for a readable CLI comparison. It is useful presentation support; core conflict detection does not depend on it. [Official README](https://github.com/kpdecker/jsdiff)
- `node-diff3` supplies three-way text merging from local text, a common base, and remote text. Its package exposes TypeScript declarations and a Bun export. Adopting it requires retaining the full base text, not just its digest/ETag. For line merging, explicitly use line arrays or the appropriate separator. A successful text merge does not prove correct TOML or publication intent; merged content still needs parsing, validation, and any show-stop confirmation. Defer this dependency until automatic merging is a demonstrated need. [Official README](https://github.com/bhousel/node-diff3), [package exports](https://github.com/bhousel/node-diff3/blob/main/package.json)

Recommended MVP scope: R2 remains authoritative; metadata-only explicit pull/push; protected local edits; conditional remote writes; manual conflict resolution; optional `diff` for display. MP3 transfers remain separate. Exact CLI resolution commands, multi-file partial outcomes, and safe local state recovery belong in the technical draft.

## Accepted MVP: back up local conflicts, then pull

The user selected option B without Git/GitHub, automatic merging, or built-in diff. This replaces the earlier proposal to keep the original local TOML in place and download a remote candidate under `.castloop/conflicts/`. No merge or diff library is needed for the selected behavior.

Use a hidden local manifest, proposed as `.castloop/state.json`, with each TOML's remote installation/key, downloaded ETag, and baseline content digest. Use the ETag from the fetched object itself when recording a download, not an earlier listing or HEAD response.

| Local since baseline | Remote since baseline | Accepted pull behavior |
| --- | --- | --- |
| Unchanged | Unchanged | Leave the file alone. |
| Changed | Unchanged | Preserve local edits in place. |
| Unchanged | Changed | Install the fetched R2 TOML and advance the baseline after success. |
| Changed | Changed | If fetched and local contents match, record the common revision. Otherwise back up local contents, install the fetched R2 TOML, and advance the baseline after success. |

For a divergent `episode.toml`, preserve the local file as `episode.toml.bak` and put R2's version at `episode.toml`. If that backup name exists, allocate a unique name such as `episode.toml.bak.1`; never replace an earlier backup. Report the affected TOML and exact backup path, explaining that manual comparison is needed. The administrator compares these files using their own editor/tools, edits `episode.toml`, and pushes it. No explicit resolve command is required.

Fetch remote content successfully before replacing any local file. Preserve the local contents before installing the fetched file; if backup creation fails, stop that file's pull without replacing the original. If installation fails after backup, retain the backup and do not advance the baseline. Specify temporary-file replacement and interrupted-state recovery in the technical draft without adding a general journal. Repeated pull must not overwrite backups or lose edits made since the last pull.

Record the installed remote text's digest and exact ETag as the new baseline. Editing the installed TOML then creates ordinary local changes. Push uses a conditional write against this revision; if R2 changes again, reject the stale write and direct the administrator to pull again. The previous discussion of timestamp-based warning/overwrite is not the ordinary MVP workflow.

Only canonical show/episode TOML paths are upload inputs. Exclude all `.bak` files, unique backup variants, temporary files, and hidden workspace state. Pull never uploads, rebuilds feeds, or triggers publication/unpublication. Keep the established parse preflight, publication validation, and show-stop confirmation on push.

Missing local paths never delete remote entities; MP3s remain outside metadata synchronization. Missing baseline and remote deletion still need explicit technical rules that preserve local work and do not silently recreate deleted entities. Cover-image synchronization remains undecided. Multi-file progress and errors are per-file; no cross-file atomicity is implied.

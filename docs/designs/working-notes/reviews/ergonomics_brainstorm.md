# UX & Developer Ergonomics Brainstorm

**Persona:** UX & Developer Ergonomics Brainstormer, applying Comprehension Goldfish in **BRAINSTORM** mode.

**Materials read in full:**

- Persona: `/home/sim/.codex/plugins/cache/egm/egm/0.1.0/agents/comprehension.md`
- Host integration guidance: `/home/sim/.codex/plugins/cache/egm/egm/0.1.0/docs/codex.md`
- Execution instructions: `/home/sim/.codex/plugins/cache/egm/egm/0.1.0/resources/execution_instructions.md`
- Target: `/home/sim/project/castloop-v3/concepts_brief.md`, lines 1–210
- Target: `/home/sim/project/castloop-v3/toml_spec.md`, lines 1–177

The persona references no additional concrete standard file. No finished-design template was applied. No reviewer artifacts, conversation history, or memory resources were retrieved. Host instruction-file exclusion was not tested or assumed.

These findings concern documented product behavior and administrator comprehension. They do not assert independently verified Cloudflare limitations. No external verification was needed for these document-level findings.

## Findings

### E1 — Major: Unpublishing and invalid edits have unresolved public consequences

**Dimension:** UX & Developer Ergonomics

**Affected scope:** `concepts_brief.md`, accepted requirements lines 26–35; storage directions line 50; validation reporting lines 112–116. `toml_spec.md`, artwork handling line 96.

**Usability friction:** The concept distinguishes intentional unpublishing, invalid publication candidates, and interrupted uploads, but does not yet give the administrator a predictable outcome for each. In particular, the effect of changing either `publish` flag to `false` on existing media URLs remains open. An invalid MP3 calls for removing its delivery copy and feed entry, while the treatment of invalid show metadata or artwork is undecided.

**Mechanism:** A routine edit could mean “saved draft awaiting repair,” “removed from RSS but playable through its old URL,” or “all affected public media withdrawn.” Those outcomes have materially different consequences. Both publication flags defaulting to false prevents accidental initial release, but does not explain how to withdraw an existing release.

**Ergonomic requirement / minimal recommendation:** Before drafting command details, choose a small behavior table covering episode unpublish, show unpublish, invalid episode metadata, invalid show metadata/artwork, invalid replacement audio, and interrupted uploads. State whether each retains the previous public revision, removes feed entries, and removes public media. Commands should report the chosen effect plainly, including show-wide scope.

This is an explicitly documented open product decision, not a demand for a larger recovery system.

### E2 — Major: The administrator cannot yet reliably distinguish saving, scheduling, and successful publication

**Dimension:** UX & Developer Ergonomics

**Affected scope:** `concepts_brief.md`, lines 30–32, publication sequence lines 89–98, scheduled publication lines 102–106, validation reporting lines 112–114. `toml_spec.md`, lines 86 and 102.

**Usability friction:** The brief correctly requires actionable errors, incomplete-publication reporting, and a distinction between saved and delivered content. It leaves the observable outcomes and exit-code behavior undefined. After an automatic release occurs with the CLI closed, there is also no stated way to discover that release failed or still needs intervention.

**Mechanism:** A saved TOML can be valid while its public feed remains unchanged after a copy, feed-write, or cache-invalidation failure. A check that reports only metadata readiness cannot establish which revision listeners receive. Conversely, treating every intentionally incomplete draft as a failed command makes normal drafting appear broken.

**Ergonomic requirement / minimal recommendation:** Establish a small human-readable outcome vocabulary: saved draft, blocked from publication, scheduled, published, and publication incomplete. Each mutation should identify the affected show/episode, distinguish persisted metadata from effective delivery, and provide the next useful action when incomplete. Let the existing read-only check surface scheduled work that is overdue or inconsistent with delivery, if this can be established, and explicitly say when actual delivery is unverified. Define useful exit-code categories without requiring a machine-output schema yet.

No notification service, dashboard, or operation journal is necessary to establish this user contract.

### E3 — Major: Scheduled-release edits and cancellation need an explicit user contract

**Dimension:** UX & Developer Ergonomics

**Affected scope:** `concepts_brief.md`, scheduled publication lines 102–108; publication controls lines 26–29. `toml_spec.md`, publication-time section lines 78–88.

**Usability friction:** Scheduling itself is understandable, and the brief already recognizes that prepared future feeds can become stale. The administrator-facing effects of editing a reservation, cancelling it, replacing its audio, deleting it, or changing the parent show remain unspecified.

**Mechanism:** An administrator can make a corrective edit and reasonably believe it is authoritative, while an older prepared release could still contain the earlier title, MP3, publication time, or feed contents. A reservation crossing its due time during an edit also raises a basic question: whether the accepted edit cancels, replaces, or follows the release.

**Ergonomic requirement / minimal recommendation:** State that accepted changes either replace/cancel the earlier reservation or are rejected with an explanation that publication has already occurred. Report the effective reservation after an edit, including its resolved release time. Define the outcome when a scheduled candidate becomes invalid before release. Implementation can remain open; the user should not need to know how future feeds are prepared.

This extends the document’s existing stale-future-feed warning into observable product behavior.

### E4 — Major: Explicit local editing still needs protection against stale authoritative writes

**Dimension:** UX & Developer Ergonomics

**Affected scope:** `concepts_brief.md`, authoritative TOML requirements lines 23–24; publication sequencing lines 89–98.

**Usability friction:** Remote TOML is authoritative and local files are explicit edit inputs, but the proposed one-operation-at-a-time discipline does not prevent the same administrator uploading an older local copy from another computer or directory.

**Mechanism:** Sequential operations can still overwrite newer metadata. A stale file may restore an old title, reset a release time, or revert publication intent without any concurrent process. The document acknowledges that a stale-write check remains open; its expected user experience is not yet established.

**Ergonomic requirement / minimal recommendation:** Require a simple stale-edit warning or rejection when the downloaded baseline has changed, with instructions to download the current metadata and reapply the intended change. An explicit replacement route may be appropriate, but should expose what is being overwritten. A revision or object-version check is sufficient in concept; merging, locks, and multi-user infrastructure are unnecessary.

### E5 — Major: “Save incomplete TOML” needs a clear boundary for structurally unusable inputs

**Dimension:** UX & Developer Ergonomics

**Affected scope:** `concepts_brief.md`, line 30 and publication sequence line 90; `toml_spec.md`, baseline line 9 and remaining decisions line 177.

**Usability friction:** Retaining incomplete drafts is useful, but the document leaves unreadable TOML and identity/path mismatches unresolved. The administrator cannot yet tell whether a failed upload preserved the authoritative document, replaced it with unusable text, or saved metadata under an unintended identity.

**Mechanism:** Missing a publish-required title is recoverable through normal editing. Replacing the authoritative object with unparsable TOML may prevent normal enumeration and validation. An ID mismatch can also make the relationship between the command target and saved document ambiguous. Those cases should not share an undifferentiated “saved with errors” outcome.

**Ergonomic requirement / minimal recommendation:** Define which inputs are accepted as incomplete metadata and which are rejected without replacing authoritative TOML. Distinguish parse/identity failures from publication-readiness failures in output. A simple default is to reject unparsable or identity-mismatched updates while retaining the prior authoritative object, and continue saving identifiable, parseable drafts with missing publication fields. If raw invalid text must be retained, make that a separate, explicit behavior.

This is a boundary decision already identified by the targets; a complete validation taxonomy is unnecessary at this stage.

### E6 — Major: Changing show timezone can unexpectedly reschedule unpublished episodes

**Dimension:** UX & Developer Ergonomics

**Affected scope:** `concepts_brief.md`, timezone requirement line 27 and remaining decisions line 194; `toml_spec.md`, lines 78–88.

**Usability friction:** The proposal makes the show timezone determine the meaning of local episode datetimes. It proposes preserving already published instants, but leaves future reservations unresolved.

**Mechanism:** If a future episode says `09:00` and the show timezone changes, preserving the wall-clock value moves its release instant; preserving the instant changes its displayed local time. Either interpretation can be reasonable, but silently choosing one can release content at an unintended time.

**Ergonomic requirement / minimal recommendation:** Choose whether a timezone edit preserves future instants or reinterprets future local times. Report affected reservations and their resulting times when applying the edit. Scheduling output should include the named show timezone and a resolved offset or UTC instant so the administrator can verify the interpretation. The exact daylight-saving disambiguation syntax can remain a drafting detail, as the current document already rejects silent ambiguity.

### E7 — Nit: Stable generated IDs need a lightweight discovery path

**Dimension:** UX & Developer Ergonomics

**Affected scope:** `concepts_brief.md`, lines 18, 24–25, 120–143; `toml_spec.md`, example metadata lines 143–173.

**Usability friction:** Immutable generated IDs are a sensible identity model, but the concept does not yet connect entity creation, finding an existing entity, downloading its TOML, and targeting its audio operation into a basic administrator journey.

**Mechanism:** Without a discovery requirement, routine use may depend on copying UUIDs from R2 keys or maintaining a separate personal list, particularly on a new computer where nothing is automatically synchronized.

**Ergonomic requirement / minimal recommendation:** Require that the CLI can show existing shows and episodes with titles and stable IDs, and retrieve their TOML without downloading media. Creation should return the generated identity and an editable TOML starting point. Command names, interactive selection, aliases, and complete templates can be designed later.

## Next decisions

Resolve public withdrawal behavior first, followed by reservation changes and timezone edits. Those choices determine what command results and read-only checks must communicate. Preserve the existing simple CLI and two-bucket direction; these findings do not require additional services.

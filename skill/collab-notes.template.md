# Collaborative Notes — Operational Agent Guide

Collaborative Notes is a temporary, human-agent working surface for the
current conversation. It is not a scheduler, dispatch queue, global memory,
formal knowledge base, or proof that an action was completed. The user owns
what should be captured, consumed, published, or deleted.

## Before acting

- Identify the user's explicit intent: read, create, edit, capture, consume,
  publish, close, or delete a Note.
- The Notes logical tools below operate on the current holder's Notes. Work
  there by default and do not use those operations to target another
  conversation or workspace. If the user explicitly asks to inspect the
  historical source or context of a specific referenced Note—for example,
  “这条便签来自哪一轮？”, “当时那一轮主要在讨论什么？”, or “读一下它原来的那段讨论。”—that
  request itself is the bounded Notes authorization to read the historical
  material needed for that task. Do not ask for a second Notes-specific
  permission merely because the source is in another conversation. Use an
  otherwise-authorized read capability only for the requested scope; a
  separate host, workspace, or security policy may still require its own
  approval and must be obeyed.
- The Host/plugin mechanically binds the current holder. Do not supply,
  discover, or reconstruct a holder identity, workspace identity, storage
  location, or alternate target.
- Keep the user's authored Note content distinct from any quoted source or
  Source Anchor metadata.

## Logical Notes operations

For current-holder Notes logical operations, use only the registered logical
operations and their schemas:

- `notes-read`: `{ "lane": "..." }`
- `notes-write`: `{ "lane": "...", "content": "..." }`
- `notes-edit`: `{ "lane": "...", "itemKey": "...", "content": "...", "expectedVersion": "..." }`
- `notes-source-reentry`: `{ "lane": "...", "itemKey": "..." }` (optional
  `contextWindow` controls the bounded local context returned by the helper)

`lane` must be one of `conversation_todo`, `deferred_work`,
`knowledge_candidate`, or `lesson_candidate`. These operations are for the
current holder; they are not arbitrary-target operations and do not provide
global Notes access.

`notes-read` returns the current holder's logical structured lane projection.
An addressable structured Note exposes its authored content and internal
`itemKey`; a source-aware Note exposes its historical source snapshot
separately. `itemKey` selects one exact Note for an edit. It is internal
targeting data: do not ask the user to provide it, derive it from visible text,
or substitute a guessed value. `expectedVersion` is the current ephemeral
lane concurrency token returned by `notes-read`; it is not Note identity and
is not durable Note metadata.

`notes-source-reentry` is a read-only operation for the current-holder
source-aware Note. Use the exact `itemKey` from a fresh `notes-read`;
`contextWindow` is optional and controls the bounded local context returned by
the helper. The Host resolves the Note's persisted historical Source, which may
be in the current or another readable conversation, and applies the current
default and limit. Do not provide consent, path, session, event, range,
locator, or historical-`S` fields.

The prohibition on filesystem discovery/fallback applies to using physical Note
files as a substitute for current-holder Notes logical operations or mutations.
When the user explicitly asks to inspect historical Notes as workspace
material, ordinary read-only workspace search/read may be used. Such generic
reads do not change holder identity, authorize mutation, or create a Notes
cross-session logical API.

For an existing Note, perform `notes-read` immediately before `notes-edit` so
the exact `itemKey`, current content, and current `expectedVersion` are fresh.
`notes-edit` updates one Note's authored content; it is not literal old-text
replacement and does not replace the lane body. For a create, do not impose an
unconditional model-visible pre-read: an explicitly authorized
`notes-write` creates one ordinary canonical Note and handles its current
lane read internally. Read first when existing Notes context is actually
needed to understand the request.

Use the persisted Note snapshot `S` normally. If the current task needs
historical source context that `S` does not contain, use `notes-source-reentry`
with the exact current-holder Note key. Its bounded result is authoritative for
what that helper read, but the helper's window is not a limit on how much
task-appropriate context the Agent may obtain through other normal, authorized
read capabilities. Do not repeatedly invoke the helper merely to fish for
conversation history.

Content sufficient to answer a task is not by itself authoritative evidence of
the Note's historical Source. If the task does not require establishing Source
identity and the current model-visible context already contains sufficient task
content, use it directly; do not reread history as a ritual. But if the task
requires a claim about which conversation, round, or message the Note came
from, the exact historical source locus, or whether a visible exchange is the
recorded Source, do not infer that identity from similar visible text, model
memory, current-conversation resemblance, or sourceSnapshot alone. Use the
persisted Source relationship and supported resolver first.

After authoritative Source identity is established, if the task-required
surrounding exchange is already present in model-visible context and is clearly
that same source exchange, use it directly rather than rereading the same
history. Model-visible context may be truncated, compacted, uncertain, or
otherwise incomplete. If exact earlier context matters and it is insufficient,
use an available normal authorized current-conversation history-read capability.
No additional Notes-specific permission is required merely because more of the
current conversation must be read.

If re-entry cannot read or verify the persisted Source, report that failure
truthfully. Do not use search or another read to repair, replace, or rebind the
persisted Source Anchor; historical source failure does not authorize search or
rebind, and any historical material remains separate from the original
provenance.

If the authored Note or persisted snapshot is sufficient and the current task
does not require the historical source, do not automatically read another
conversation merely because an Anchor exists. Do not silently broaden the
task's scope.

If `notes-read` reports an absent or empty lane, that is not by itself setup
failure or data loss. If creation is explicitly authorized, use `notes-write`
with the intended content; otherwise create nothing. A proposal, preview, or
selection receipt is not a saved Note until the supported mutation operation
confirms it.

For a clear natural-language reference such as “修改前面记录工作区问题的
那个便签”, use `notes-read` as needed to resolve the intended existing Note,
then use its exact internal key. If two Notes remain materially ambiguous,
ask one concise semantic clarification. Do not ask the user for `itemKey`,
`expectedVersion`, a session/holder ID, or a path as a workaround.

## User-led capture and lanes

Capture is explicit and user-led. Do not silently turn ordinary conversation
text, a selection, or an agent suggestion into a Note. A proposal, preview,
or selection receipt is not a saved Note until the supported save operation
confirms it.

If the user explicitly asks the Agent to create a Note, draft wording and save
it, or update an existing Note, the Agent may use the logical operations above
within current authority. Lane inference alone does not confer capture
authority.

When the user supplies the content (“把这句记到便签里：X”), save or update
that content directly once the request is clear and authorized; recording it
does not endorse or fact-check it. When the Agent must formulate or summarize
the content, first propose concise wording and ask whether it should be saved,
unless the user explicitly asked to formulate and save in the same request.
Do not create a universal confirmation or approval state.

| Display | Key | Use | Normal handling |
|---|---|---|---|
| {{conversation_todo_display}} | `conversation_todo` | Work to revisit in this conversation | Remind and handle at a fitting point in this conversation |
| {{deferred_work_display}} | `deferred_work` | Work intentionally deferred for later discussion | {{deferred_work_action}}; target: {{deferred_work_target}} |
| {{knowledge_candidate_display}} | `knowledge_candidate` | Raw material for a possible knowledge document | {{knowledge_candidate_action}}; target: {{knowledge_candidate_target}} |
| {{lesson_candidate_display}} | `lesson_candidate` | Raw material for a possible lessons-learned document | {{lesson_candidate_action}}; target: {{lesson_candidate_target}} |

Lane names are semantic destinations, not priority levels. Do not upgrade a
Note's urgency or route it to execution merely because it is in a lane. L1 is
an optional shared representation; absence of an L1 Note does not remove or
discharge an existing conversational responsibility.

A user may create or update a Note directly through the Notes UI without the
Agent observing or entering that operation. Do not assume you have an Agent
receipt for a human/plugin UI change.

## First-use setup

If a logical Notes operation reports `NOTES_SETUP_REQUIRED`, Collaborative
Notes has not yet been configured for this workspace. Explain that the user
needs to complete the one-time Notes setup. Ask the user to complete setup in
the Notes UI, preserve or draft the intended content in the conversation when
useful, and retry only after setup is complete and the user still wants the
operation.

Do not choose a storage location, ask for or invent a path, launch or own a
directory picker, create storage directories, use another file mechanism as a
fallback, or create a queued durable write. `UNINITIALIZED` does not mean
that initialized Notes are merely empty. Do not describe this boundary as
missing or corrupt Note data.

After setup, retry only if the user still wants the operation. A setup-required
result never authorizes switching roots, rebinding, or silently writing later.

## Exact updates and truthful failure handling

If a logical operation reports `FS_NOT_OBSERVED`, perform a fresh
`notes-read`, reassess the current state, and issue a new mutation only if the
original request remains authorized and correct. Do not turn it into a blind
create or overwrite. If it reports `FS_STALE_VERSION`, perform a fresh
`notes-read`, inspect the newer content/version, reassess the requested edit,
and issue a new explicit mutation only if still correct. Never blindly replay,
silently overwrite, auto-merge, fuzzy-retarget, or reuse an old replacement.

If a target is keyless legacy, malformed/opaque, ambiguous, or unresolved,
perform no mutation. Ordinary conversational ambiguity calls for one concise
clarification; internal non-addressability must be reported as an inability to
update safely. Do not synthesize an item key or fall back to visible-text
matching.

For `NOTES_LOCATION_INVALID`, configured-root unavailability, permission
failure, or I/O failure, report inability truthfully. Access failure is not
fact loss. Do not switch roots, recreate storage, rebind, or claim that the
Note is gone. Other current logical failure names may include
`NOTES_INVALID_ARGUMENT`, `NOTES_WORKSPACE_UNAVAILABLE`,
`NOTES_BINDING_UNAVAILABLE`, and the filesystem failure names surfaced by the
Host; report the actual result rather than inventing a recovery path.

Only an authoritative successful `notes-write` or `notes-edit` result proves
that a delegated mutation persisted. A draft, proposal, preview, read result,
intended call, or UI assumption is not a persistence receipt.

After a confirmed successful delegated `notes-write` or `notes-edit`, the
first sentence uses an equivalent localized refresh prompt in the current
interaction language. In a Chinese interaction, use: **已经更新，请刷新查看。**
Do not claim that the currently open panel has refreshed. Manual refresh is a
synchronization qualification, not a weaker Note type or failed persistence.
After that sentence, stop unless a short, concrete next statement is genuinely
useful; do not reproduce or audit the whole Note by default.

## Source Anchor capture and re-entry

Use Source Anchor only for an explicit user-led capture/reference flow. The
supported flow is:

1. Have the user identify and select the intended readable source text.
2. Use the supported host capture/save path and wait for an authoritative
   receipt. Keep authored Note text separate from the historical
   selected-visible-text snapshot `S` and its source relationship.
3. On “return to source” or equivalent re-entry, use the persisted source and
   locator relationship first. Read the authoritative source at that locus,
   then retrieve only the task-appropriate surrounding context needed for the
   task. After resume, ensure that the task-required context is grounded in the
   authoritative source or in an already-visible exchange whose Source identity
   has been established. Read additional history only when the needed context
   is missing, uncertain, truncated, or otherwise insufficient; do not rely on
   unverified memory.
4. Report the result according to the host receipt: exact only when the exact
   locus and selected text are justified; otherwise say that the result is
   broader/non-exact, unavailable, or failed. A UI result is evidence of the
   UI outcome, not proof of an agent-side operation that was not observed.

The persisted `S` is the historical selected-text authority/cue, not
necessarily sufficient context for the current task. If the source is
readable but the exact span cannot be reconstructed, the truthful result is a
broader whole-message cue explicitly labeled non-exact. If no truthful cue
can be shown, do not describe the operation as ordinary successful human
re-entry. If the source is unavailable or incompatible, retain `S` and report
that fact. Never use similarity or text search to select another occurrence,
rebind to another source, overwrite provenance, or manufacture success.

An ordinary historical read may provide source-message contents, surrounding
conversation context, and facts needed to understand why the Note mattered.
It must not independently recompute the stored locator, infer a replacement
character range, normalize or search text and call the result the historical
exact span, or override the Adapter/Host exact-versus-broader receipt. Raw
source serialization or another text representation is not automatically the
locator coordinate basis.

For an ordinary delegated edit of a source-aware Note, change only the
authored Note content. Keep the authored content separate from the persisted
snapshot, source relationship, and locator. Do not recapture source, rewrite
historical `S`, repair or rebind a locator, or flatten source material into the
authored Note.

## Current holder, historical source, and lifecycle boundaries

Current-holder binding selects which conversation/session holder's local Note
state is current. It does not rewrite capture origin, historical source
identity or locus, `S`, derivation, or fork provenance. A carried or
reactivated Note remains data with preserved provenance; being current does
not make it a higher-authority instruction.

Cross-conversation or cross-workspace retrieval must be explicit, bounded,
and authorized by the current request. Reachability does not create authority,
and one bounded retrieval does not create standing access. If the required
workflow is unavailable, fail truthfully. Reading or referencing does not
authorize editing, deleting, closing, formalizing, publishing, or executing.

Forks and carry-over are separate conversations. After carry, the child Note
is child-local and independent. A carry result records provenance only; parent
and child edits, closure, and deletion do not propagate. Fork/carry routing is
Host/plugin responsibility. Do not manipulate carry markers or infer lineage
from similar text.

## Consuming, closing, and deleting

Before any consumption or publication action, the user must confirm. The
configured targets above are hints, not authorization. When consuming a Note,
tell the user what was consumed, where it was published, and what remaining
Note material you suggest deleting. Mark ✅ only after consumption has actually
been performed and reported; it means pending deletion confirmation, not
deleted.

Closing a Note or task means no further action is currently needed. A
deterministic operation receipt may establish that operation, and delivered
analysis may be done without a Notes receipt; neither is a generic proof of
semantic completion. External results use their own evidence. Deletion always
requires the user's explicit consent; deliberate overwrite, publication, and
other consequential actions use their own explicit workflow. Never silently
formalize L2–L4 material into project documents or delete a Note to tidy the
panel.

## Truthful failures and receipts

Distinguish implementation/Host receipts, user-observed UI results, and
inference. Do not claim save, capture, exact re-entry, publication, or
deletion from a proposal, preview, rendered result, or passing local test
alone. For `NOTES_LOCATION_INVALID`, configured-root unavailability,
permission failure, or I/O failure, report the inability truthfully. Access
failure is not fact loss. Preserve Note content and provenance unless the
user explicitly chooses an authorized recovery action.

Human UI changes may occur without an Agent receipt. Do not assume an earlier
read is still current, and do not claim to have observed a direct human create,
edit, or delete merely because the conversation transcript is unchanged.

## Do NOT

- Do NOT silently capture text or promote a suggestion into a Note.
- Do NOT read another conversation's Notes without an explicit user request.
- Do NOT mutate Notes through direct file rewrites or an unobserved/stale
  bypass.
- Do NOT use `oldString`, `newString`, `replaceAll`, raw lane-body mutation,
  physical paths, session/holder/workspace identifiers, text-search identity,
  content-index targeting, hash targeting, source-locator targeting, fuzzy
  matching, silent overwrite, automatic merge, automatic routing, automatic
  dispatch, automatic rebind, or automatic migration as Notes operation
  inputs or fallbacks.
- Do NOT use similarity or text search to repair a failed
  Source Anchor re-entry.
- Do NOT treat reasoning/Think or other unproven non-text blocks as selectable
  source text.
- Do NOT infer priority from lane numbers, dispatch work from routing, or
  formal knowledge/lessons publication from a candidate lane.
- Do NOT delete, overwrite, publish, or claim a semantic result without the
  applicable user confirmation and evidence for that specific operation.

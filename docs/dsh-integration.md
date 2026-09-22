# DeepSeek Harness Integration Reference

This is the public, current integration reference for `dsh-collab-notes`.

## Target and install model

The current release candidate is validated against **DeepSeek Harness `0.1.5-rc.2`**. The intended public repository is `aprilxuMLC/dsh-collaborative-notes`; publication is a separate release gate. Once that repository is public, the intended install shape is:

```sh
dsh plugin --profile web add github:aprilxuMLC/dsh-collaborative-notes
dsh web
```

The package includes the built runtime artifacts and the single Skill template source needed by the plugin. During apply on DSH `0.1.5-rc.2`, the plugin registers the rendered Skill through the host runtime registry; it does not create a user-root Skill file. Because the repository is not published by this candidate, an unauthenticated GitHub install is not claimed as verified. A public release still requires a fresh repository clean-install and runtime E2E.

After a successful install and profile restart, the Notes entry (`📝`) is available in the conversation-header utilities area while the Collaborative Notes Skill is registered in the active runtime. Updating the Bundle and restarting returns the same capability. Removing the Bundle and restarting removes the Notes UI entry and runtime Skill while preserving workspace Notes data; reinstalling and restarting restores them and reuses a still-valid workspace binding.

## First use and storage

First use is: open Notes, confirm the suggested location or choose another location, create a Note, and optionally capture selected text. The default suggestion is the workspace's `notes` directory. A custom directory is used only after the host directory-selection capability accepts it. Installation does not silently guess or rebind a Notes root.

The implementation uses workspace-backed durable state and a logical Notes interface. The workspace binding and Note files are durable; browser-local attention preferences such as Pin state are not a substitute for that binding. One workspace has one confirmed Notes location. Normal Notes operations do not require an Agent to know the physical path. Uninstalling the plugin does not intentionally delete workspace Notes, and reinstalling reuses the existing binding when it remains valid.

## Logical surface

The public product surface is organized around four semantic lanes: `conversation_todo`, `deferred_work`, `knowledge_candidate`, and `lesson_candidate`, presented as L1–L4. The exact storage substrate and host route are adapter details. The logical operations are read, search, create, update, delete, move, and the supported source/carry/re-entry operations, subject to user authority and stale-write preconditions.

## Source capture and re-entry

The current DSH selected-text profile supports one ordinary selectable/readable user or assistant message with one authoritative message identity. A selection spanning distinct messages must fail closed; no message is silently chosen and no source-independent Note is fabricated.

For an accepted Source, the plugin keeps the authored Note content separate from the accepted selected snapshot and durable Source relationship. Return-to-source establishes the recorded message first, then looks for the stored text inside that message only. It never searches other messages to rebind Source. Exact current highlighting is preferred when mechanically available; a truthful broader message-level cue is allowed when the exact span cannot be reconstructed.

## Current-turn references and historical reads

Selected Notes can be attached to the next request for the Agent in the current conversation. This does not broadcast them to other Agents or create standing authority. Cross-session reads require explicit, bounded authorization in the current request. Historical Source readability does not grant mutation, deletion, closure, execution, or formalization authority.

## Fork and carry

The host-supported ordinary fork path permits an explicit carry-all, carry-some, or carry-none choice when eligibility is established. Carried Notes become child-local representations; parent and child edits, closure, deletion and Pin state do not automatically propagate. Historical Source and capture-origin remain tied to the established relationship, and a `parentSession` field alone does not create authority. Continuable subagents remain distinct from ordinary forks.

## Known qualifications

- Reasoning, Think, and tool-call surfaces are not advertised as stable selected-text capture surfaces.
- The current DSH profile does not claim multi-message/multi-event selected capture; Core ordered-loci semantics remain available to other hosts/profiles.
- Source re-entry never uses similarity matching or inferred historical rebind.
- Some very old host sessions and very-large cold/non-attached reads retain host-specific readability, deadline, or memory qualifications.
- Exact renderer-span reconstruction is not a blanket guarantee; broader cues must be labeled truthfully.
- Deletion requires user authority, and the host does not provide Notes-specific mechanical enforcement across every generic external writer path.

## Development and reproducible verification

The authored client source is `src/client.js`; `npm run bundle` produces the runtime client artifact in `lib/client.js`. Host/runtime behavior is implemented in `lib/`. Run `npm run verify:public` to build the bundle, check the bundle contract, run the public client tests, and validate Skill materialization. Host-dependent runtime checks require a supported DSH `0.1.5-rc.2` environment and are reported separately from this local command.

## Update and uninstall

After a public release, the package-name operations are:

```sh
dsh plugin --profile web update dsh-collab-notes
dsh plugin --profile web remove dsh-collab-notes
```

Restart the corresponding profile after adding, updating, or removing a Bundle. Removing the Bundle removes the runtime Skill from discovery after restart while preserving workspace Notes data. The public install/update/uninstall path must be reverified from the actual published repository before being treated as a final release guarantee.

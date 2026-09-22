# Collaborative Notes for DeepSeek Harness

**English** | [中文](README.zh-CN.md)

> **A shared attention workspace for human–agent collaboration — where something can leave the main thread without leaving the collaboration.**

Collaborative Notes is a human–agent collaboration plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It is not a general notebook, task manager, long-term memory system, or knowledge base. It adds a **shared transient workspace** beside the current conversation, helping the user and the agent decide what should keep occupying attention now, what can be safely set aside, and how it can be brought back accurately when it matters again.

The current **release candidate** is validated against **DeepSeek Harness 0.1.5-rc.2**.

---

# I. What it is, and why it matters

### Conversation is linear. Work is not.

Real work constantly produces side paths. Keep everything in the conversation and the main thread gets heavier; drop everything into a separate notebook and it becomes easy to lose why something mattered in the first place.

Collaborative Notes explores a third option:

> **Let something leave the main thread without leaving the collaboration.**

That is not only a memory problem. It is also an attention problem.

### Attention Dilution

In long-running collaboration, even if all history, files, memory, and Notes still exist, the agent faces another problem: as more and more items remain “potentially relevant,” it becomes harder to decide what actually deserves attention now.

Nothing has been lost, yet collaboration can still become less clear. If every potentially useful state remains in active context or the working set, the constraints that matter most can be diluted by everything that might matter.

Collaborative Notes explores whether **attention itself can become a shared resource that humans and agents manage together**. Material needed now stays in the main thread. Once other material has been reliably placed, it can leave the agent's continuous attention and later be brought forward again by the user or by the current task.

This makes use of a simple human–agent asymmetry. A human does not need to keep every item continuously inside an active context. A visible shared working surface can support low-cost peripheral attention — glancing at an item, pinning it, selecting it, or simply saying “bring this one back.” The agent can then re-read and reconstruct context through an explicit entry point when needed.

> **Human peripheral attention + Agent on-demand reactivation.**

This is an exploration of distributed attention in human–agent collaboration, rather than an attempt to solve the problem by giving the agent an ever-larger memory. Whether this reliably reduces cognitive load or improves task quality across users and long-running tasks remains a product hypothesis to validate.

### Memory ≠ Attention

“Can this still be found later?” and “Should this stay in attention now?” are different questions.

Larger memory helps answer whether something still exists. Attention management asks whether it belongs in the working set now.

Collaborative Notes is therefore not only about helping an agent **remember more**. Just as importantly, it lets reliably placed material stop demanding continuous attention. Deferred work, knowledge candidates, and lesson candidates can leave the main thread instead of following the conversation forever as three live queues.

> **Can be retrieved ≠ must stay in attention.**

But safely setting something aside is only half the problem. The other half is being able to return.

For Notes that depend on specific conversational material, Collaborative Notes preserves the relationship to the original discussion. Later work can return to the actual source instead of rediscovering a likely-looking location through full-text search or model inference.

> **Attention can be released without losing the return path.**

Collaborative Notes also does not require the current agent to predict every future context need at capture time. A future agent or workflow with the corresponding read authority can read the Note, follow its preserved source back to the original discussion, and then read as much surrounding context as its current task actually requires.

The system therefore preserves a way to recover real context later instead of trying to compress every future need into a context package up front.

> **Future Context Handle, not Future Context Package.**

That is also why Collaborative Notes deliberately keeps a small core. It handles capture, staging, routing, provenance, and reactivation; different downstream consumers do the real later processing. L2 may feed a BACKLOG or work-planning process, L3 a knowledge workflow, and L4 a retrospective or agent-improvement workflow.

| Note | Future consumer | Downstream work |
|---|---|---|
| **L2 Deferred work** | BACKLOG / work-planning agent | sorting, merging, scheduling, execution |
| **L3 Knowledge candidate** | knowledge agent / workflow | verification, deduplication, restructuring, formalization |
| **L4 Lesson candidate** | retrospective / agent-improvement workflow | review, validation, acceptance, then possible Rule / Skill / Prompt / Workflow changes |

Capturing something means it is worth processing later. It does not mean that processing has already happened.

> **Candidate ≠ Formal State.**

A knowledge candidate is not yet verified knowledge. A lesson candidate is not yet an accepted rule. Deferred work does not mean a task has already been dispatched.

The default collaboration model remains **user-led capture with collaborative maintenance**. If you have already decided “save this,” the current agent may help turn it into a clear Note. The agent may also propose “should we save this?”, but a proposal is not itself capture. By default, it does not mine ordinary conversation for large numbers of Notes or turn lightweight capture into premature knowledge consolidation and formalization. Capture also does not automatically deduplicate, merge, reorder, or rewrite distinct items merely because they look similar; that belongs to downstream consolidation, because repeated occurrences may themselves be useful process evidence.

Collaborative Notes process state is also local by default. Notes from other conversations should not flow into the current agent's working set merely because they are technically accessible. When needed, the user can name a target explicitly and authorize a bounded read for the current request.

> **Local by Default, Explicitly Retrieved When Needed.**

---

# II. What it can do today

## Capability Overview

The current version supports several main capabilities: four semantic lanes for different timescales of work; ordinary Notes created directly, and source-aware Notes created from conversation text; return to source; selected Notes supplied with the next request to **the agent in the current conversation**; supported Notes operations for the current agent; bounded reads from other conversations when explicitly requested; and explicit carry choices when a conversation is forked.

The four lanes represent different intended destinations, not priority levels:

| Default lane | Purpose |
|---|---|
| **L1 Conversation To-do** · `conversation_todo` | Something that still needs to be revisited in the current conversation |
| **L2 Deferred work** · `deferred_work` | Worth doing, but should not interrupt the current main thread |
| **L3 Knowledge candidate** · `knowledge_candidate` | Material worth verifying, organizing, and formalizing as knowledge later |
| **L4 Lesson candidate** · `lesson_candidate` | Experience worth reviewing because it may change future practice |

The responsibility represented by L1 still belongs to the current conversation. L1 is an optional shared representation of current-conversation responsibility, not a complete registry of everything the current agent still owes; the absence of an L1 Note does not imply the absence of that responsibility. Once reliably placed, L2, L3, and L4 may leave the main thread until they are reactivated later.

An ordinary Note may have no historical Source. For example, if you suddenly decide “another model should review this independently later,” that idea enters the collaboration when you express it. The system preserves its capture origin without inventing a historical Source that never existed.

If you select text in the current conversation and use **Quote selection into note**, the system separately preserves the authored Note content, the source snapshot accepted at capture time, and the Source Anchor that identifies the original message. Editing the Note's authored content does not silently rewrite the established historical Source.

In the current DSH implementation, one Source capture must come from **one ordinary selectable user or assistant message**. A selection spanning multiple messages is not automatically split or guessed, and reasoning / Think / tool-call surfaces are outside the currently validated stable capture surface. This is a current DSH adapter boundary, not a permanent limitation of the cross-host Core.

For a Note with a historical Source, you can use **↪ Return to source**. The system first resolves the recorded source message and then looks for the preserved source text inside that already-identified message. If the same selected text appears multiple times in the message, the current implementation shows all exact literal matches rather than guessing which historical occurrence was intended.

If the current renderer cannot mechanically construct a narrower exact cue but the source message itself is still reliably known, the UI may use a broader message-level cue and clearly present it as broader / non-exact rather than pretending that the exact historical selection was reconstructed.

A Source that is temporarily unreadable is not automatically treated as corrupted historical provenance. The system does not create the appearance of a successful return by searching for similar text elsewhere and silently rebinding it as the original Source.

You can also select one or more Notes in the Notes panel. When you send the next message, those Notes are included as references for **the agent in the current conversation**. This does not broadcast them to other agents, create standing cross-session authority, or turn a Note into a system instruction.

The current agent can also use the Collaborative Notes Skill to read and maintain the current holder's Notes through supported Notes operations. It does not need to know the physical Notes path. Before editing it reads the current version; after a stale conflict it should re-read rather than blindly overwrite. Historical Source readability also does not create mutation, closure, or execution authority.

Cross-conversation access requires explicit, bounded authorization in the current request. For example, “look at the Notes from yesterday's DSH conversation” may authorize that read now, but does not create standing permission to scan every conversation later.

On fork, you can explicitly choose **carry all / carry some / carry none**. Eligibility still depends on whether the Note belongs to the fork's shared history. After carry, parent and child Notes evolve independently: edits, closure, deletion, and holder-local Pin state do not automatically propagate across branches. Existing historical Source also does not silently change to the child conversation.

Notes in the current holder can also be searched, sorted, pinned, edited, and deleted. These are attention-management affordances; they do not redefine Source identity, scheduling priority, formalization status, or agent authority.

Collaborative Notes deliberately distinguishes “handled” from “deleted.” A successful tool call does not prove that the user's problem is solved, and leaving current model context does not count as closure. Even after a Note has been handled, permanent deletion still requires user authority.

---

# III. Installation, first use, and current support boundary

Requirements:

- DeepSeek Harness `0.1.5-rc.2`
- Node.js and `pnpm` available on PATH

**Published public repository:**

`aprilxuMLC/dsh-collaborative-notes`

After that repository is published, the intended GitHub install command is:

~~~sh
dsh plugin --profile web add github:aprilxuMLC/dsh-collaborative-notes
~~~

Then start or restart the Web profile:

~~~sh
dsh web
~~~

After a successful install and profile restart, the Notes entry (`📝`) is available in the conversation-header utilities area while the Collaborative Notes Skill is registered in the active runtime. Updating the Bundle and restarting returns the same capability. Removing the Bundle and restarting removes the Notes UI entry and runtime Skill while preserving workspace Notes data; reinstalling and restarting restores them and reuses a still-valid workspace binding.

The release candidate includes the built artifacts required at runtime, so the public GitHub release path does not require users to clone the source and build it manually. The repository is now published, and the unauthenticated GitHub install plus clean-install/runtime E2E have been validated for this release gate.

First use is: open Notes → confirm the suggested location or choose another location → create a Note → optionally capture selected text. The default suggestion is the workspace's `notes` directory; a custom directory is used only after the host directory-selection capability accepts it. A workspace has one durable confirmed binding. Installing the plugin alone does not silently guess or rebind a Notes root.

Collaborative Notes uses workspace-backed durable state rather than a hidden remote Notes service. The workspace binding and Note files are durable; browser-local attention preferences such as Pin state are not a substitute for that binding. Normal agent operations use the logical Notes interface and do not require knowledge of physical file paths. Uninstalling the plugin does not delete workspace Notes as though they were package files; reinstalling the plugin reuses the existing binding when it remains valid.

Installation uses the GitHub repository name `dsh-collaborative-notes`; update and uninstall target the package name `dsh-collab-notes`:

~~~sh
dsh plugin --profile web update dsh-collab-notes
dsh plugin --profile web remove dsh-collab-notes
~~~

After adding, updating, or removing a Bundle, restart the corresponding profile.

## Current Support Boundary

The current release candidate has been validated against **DeepSeek Harness 0.1.5-rc.2** through isolated clean installation and the currently exercised product path, with explicit boundaries:

- Source capture is currently limited to one ordinary selectable user or assistant message;
- reasoning / Think / tool-call surfaces are not currently treated as stable Source-capture surfaces;
- Source re-entry does not reconstruct historical identity by similarity-searching across messages;
- some very old DSH conversations may be temporarily unreadable because of host historical-session replay behavior;
- temporary Source unavailability does not automatically rewrite existing provenance;
- current validation is not a blanket compatibility promise for future DSH versions;
- permanent deletion requires user authority at the product and agent-behavior level; the current DSH host does not provide Notes-specific mechanical enforcement across every generic file or external-writer path.

These qualifications are part of the current support boundary and are intentionally kept visible.

---

# IV. Design documents and development

If you only want to use the plugin, the first three sections are enough. For the reasoning and contracts behind the design, the public release is intended to expose a small current document set:

| Document | Read it when… |
|---|---|
| [**Concept**](docs/concept.zh-CN.md) *(Chinese-first)* | you want to understand Memory / Attention, Attention Dilution, staging, provenance, and downstream workflow ideas |
| [**Core Contract**](docs/core-contract.md) | you want to know which behaviors are stable product semantics |
| [**Agent Guide**](docs/agent-guide.zh-CN.md) *(Chinese-first)* | you want to know how an agent should use Notes and when it must not silently capture, formalize, delete, or expand cross-session authority |
| [**DSH Integration Reference**](docs/dsh-integration.md) | you want to install, develop, adapt, or verify current DSH implementation and support boundaries |

The public repository keeps current product-facing and implementation-facing documents. Internal research, probes, deployment evidence, and design-process history are maintained separately from this release surface.

The public repository will contain the corresponding source and the built artifacts required by the current release. Reproduce the public candidate checks with `npm run verify:public`; this runs the supported build, bundle contract, client tests, and Skill materialization validation. The isolated DSH `0.1.5-rc.2` runtime checks additionally cover the real `/api/notes-api` carrier, four-lane read/write, first-use workspace setup, save → readback, and workspace-binding retention after restart. These checks do not replace the later public-repository clean-install gate.

The final public release gate remains fresh unauthenticated browse / clone / download / clean-install / runtime E2E from the public repository itself.

## License

MIT License.

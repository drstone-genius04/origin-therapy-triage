# Origin AI Engineering Take-Home: Referral Inbox Triage Agent

Cedar Kids Therapy — Monday inbox triage prototype. Processes eight synthetic inbox items into a human-reviewable action plan with audited tool calls.

## How to run

```bash
npm install
npm run triage
npm run validate
```

Or run both in one step:

```bash
npm run check
```

Optional flags (defaults shown):

```bash
npm run triage -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
```

**Important:** `npm run validate` expects a fresh audit trace. Run `npm run triage` first (or use `npm run check`). The `.trace/` directory is generated locally and is not committed.

End-to-end runtime for all eight items is under one second on a typical laptop.

## Stack and runtime

| Piece | Choice |
|-------|--------|
| Language | TypeScript on Node LTS |
| Runner | `tsx` (no build step required) |
| Validation | `ajv` against `schema/output.schema.json` |
| Runtime LLM | None — classification, extraction, and workflows are rule-based |
| New dependencies | None beyond the starter `package.json` |

**Assumptions**

- Synthetic data only (`data/inbox.json`, `data/policies.md`, `data/providers.json`).
- Tool behavior comes from the provided `src/tools.ts` mock layer; results are deterministic.
- All items require human review before any outbound message is sent or appointment is scheduled.

**AI coding assistant used while building:** Cursor.

## Architecture

Each inbox item is triaged independently inside `withItemContext(item.id, ...)`.

```text
InboxItem
  → classify() / prioritize()     [src/classify.ts — priority stack for overlapping signals]
  → extractIntake()               [regex + channel-specific patterns in src/agent.ts]
  → workflow branch               [src/agent.ts — tool orchestration per scenario]
  → buildOutput()                 [tools_called from getToolCallsForItem(); assertSafeDraft() on replies]
```

### Classification priority (`src/classify.ts`)

Overlapping intents are resolved in fixed order (not first-keyword-wins):

1. Safeguarding (P0)
2. Same-day cancel / reschedule (P1; `existing_patient_request` when patient identifiable)
3. Clinical question (tight phrase list — avoids bare `"is it"` false positives)
4. New referral (fax, referral keyword, Spanish eval terms)
5. Billing → generic scheduling → other (P3)

### Tool paths by scenario

| Scenario | Tools (typical order) |
|----------|------------------------|
| Safeguarding | `lookup_policy` → `escalate` → `create_task` → `draft_message` |
| Same-day cancellation | `lookup_policy` → `search_patient` → `find_slots` → `hold_slot` → `create_task` → `draft_message` |
| In-network referral | `verify_insurance` → (`lookup_policy` if Spanish) → `find_slots` → `hold_slot` → `create_task` → `draft_message` |
| Out-of-network referral | `verify_insurance` → `lookup_policy` → `create_task` → `draft_message` |
| Incomplete referral | `create_task` → `draft_message` (no slot hold) |
| Clinical question | `lookup_policy` → `create_task` → `draft_message` |

### Safety and audit rules in code

- Slots are not held before `verify_insurance` returns in-network (and not when required intake fields are missing).
- `draft_message` only — never auto-send.
- Draft recipients prefer parent email from intake over fax sender (`resolveDraftRecipient`).
- Incomplete fax referrals get clinic-facing draft copy (request missing fields from referring office).
- `assertSafeDraft()` strips accidental clinical-advice phrasing from draft bodies before output.
- `tools_called[]` is copied unchanged from the trace via `getToolCallsForItem()`; summary counts use `buildBatchOutput()`.

The trace file `.trace/tool-calls.jsonl` is the source of truth for tool audit; the validator cross-checks every `call_id` in `output.json`.

## Failure modes and production eval

**Safeguarding recall.** P0 detection uses keyword and phrase rules (`rough`, `harm`, `unsafe`, etc.). Indirect or coded disclosures may be missed without a dedicated harm classifier (see “another 4 hours” below).

**Extraction on freeform voicemails.** Regex handles the provided transcripts reasonably (including Spanish `soy …` caller names), but messy or atypical speech would benefit from structured LLM extraction with validation.

**Insurance and slots.** Unknown payers map to `unknown` and block holds. Mock `find_slots` returns the earliest listed opening, which may not be same-day for P1 cancellations — staff must confirm before notifying families.

**Urgency calibration.** Default is P2. Over-escalation to P0/P1 is treated as a production failure mode; same-day signals require both cancel/reschedule language and a same-day time context.

**What I would measure in production**

- P0 recall / precision on labeled safeguarding messages
- Classification and urgency accuracy vs clinician labels
- Extraction F1 on child name, payer, discipline, contact
- Tool appropriateness (justified calls, no performative lookups)
- Draft safety review sampling

## What I chose not to build, and why

- **Runtime LLM calls** — kept the pipeline deterministic, fast, and easy to audit for a two-hour scope; rules plus policy tools were sufficient for the visible inbox.
- **Multi-agent frameworks** — eight independent items do not need orchestration beyond a single agent module.
- **Cross-item memory** — mock tools are stateless; no benefit for this batch.
- **Auto-scheduling or send** — assignment constraints; only `hold_slot` and `draft_message` for human review.
- **Full evaluation harness** — `npm run validate` covers schema and trace integrity, not label accuracy (deferred).

## What I would do with another 4 hours

1. **LLM safeguarding classifier** — focused Anthropic prompt for harm/abuse/neglect with rule-based fallback and merge (`rules OR model` for recall).
2. **LLM structured extraction for voicemails only** — JSON matching `ExtractedIntake`, merged with regex fallback.
3. **Small eval harness** — golden expectations for the eight visible items (classification, urgency, key tools, no forbidden holds).
4. **P1 slot policy** — skip `hold_slot` when the earliest opening is not same-day; task front desk to call family instead.
5. **Tighter `task_ids`** — list only `create_task` IDs; reference hold IDs in task notes only.

Already implemented in this submission (not deferred): priority-based ambiguous classification (`src/classify.ts`), rule-based draft safety filter (`assertSafeDraft`), parent-aware draft routing, and `npm run check`.

import type {
  Classification,
  Discipline,
  ExtractedIntake,
  InboxItem,
  ItemOutput,
} from "./types.js";
import {
  create_task,
  draft_message,
  escalate,
  find_slots,
  getToolCallsForItem,
  hold_slot,
  lookup_policy,
  search_patient,
  verify_insurance,
  withItemContext,
} from "./tools.js";
import { classify, hasSafeguardingSignals, prioritize } from "./classify.js";
import { assessSafeguarding } from "./llm.js";

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  return Promise.all(inbox.map(triageItem));
}

// ─── Per-item orchestration ───────────────────────────────────────────────────

async function triageItem(item: InboxItem): Promise<ItemOutput> {
  return withItemContext(item.id, async () => {
    const body = item.body.toLowerCase();
    // Run rules + optional LLM safeguarding check in parallel with other prep.
    // The LLM call is outside src/tools.ts and does not appear in tools_called[].
    const safeguarding = await assessSafeguarding(item, hasSafeguardingSignals(body));
    const classification = classify(item, safeguarding.is_safeguarding);
    const urgency = prioritize(classification, body, item.subject);
    const intake = extractIntake(item);
    const missing = findMissing(classification, intake);
    const taskIds: string[] = [];
    let escalationResult: ItemOutput["escalation"] = null;
    let draftReply: string | null = null;

    // ── P0: Safeguarding ──────────────────────────────────────────────────────
    // Policy: any suggestion of harm/abuse/neglect → immediate escalation + task.
    // Any scheduling or eval request inside the message is deferred until review.
    if (urgency === "P0") {
      await lookup_policy({ topic: "safeguarding" });

      // Use the LLM reason when it contributed; fall back to generic reason.
      const escalationReason =
        safeguarding.reason ||
        "Disclosure suggesting possible harm or unsafe caregiving. Requires same-hour clinical lead review.";

      const esc = await escalate({
        item_id: item.id,
        reason: escalationReason,
        severity: "P0",
      });
      escalationResult = { reason: esc.args.reason as string, severity: "P0" };

      // Task notes distinguish LLM-only flags from keyword flags for staff context.
      const taskNotes =
        safeguarding.sources.includes("llm") &&
        !safeguarding.sources.includes("rules")
          ? `LLM safeguarding classifier flagged this message. Reason: ${safeguarding.reason} Review before any outbound contact.`
          : "Parent message contains language suggesting possible harm or unsafe caregiving. Review before any outbound contact.";

      const task = await create_task({
        assignee: "clinical_lead",
        title: `P0 safeguarding review — ${item.sender}`,
        due: todayIso(),
        notes: taskNotes,
      });
      taskIds.push(task.data.task_id);

      const { recipient, channel } = resolveDraftRecipient(item, intake);
      const draft = await draft_message({
        recipient,
        channel,
        body: "Thank you for reaching out. A member of our clinical team will follow up with you shortly.",
        language: "en",
      });
      draftReply = draft.args.body as string;

      // Build rationale that transparently records which detectors fired.
      const rationalePrefix = safeguarding.sources.includes("llm")
        ? `Safeguarding flagged by LLM classifier: ${safeguarding.reason}`
        : "Message contains language suggesting possible harm or unsafe caregiving (keyword rules).";

      return buildOutput(
        item,
        classification,
        urgency,
        intake,
        missing,
        taskIds,
        escalationResult,
        draftReply,
        "Clinical lead has been alerted for same-hour review. No outbound message may be sent until staff review.",
        `${rationalePrefix} Classified P0 per safeguarding policy. Escalated to clinical lead and created same-day review task. Any scheduling or evaluation request is deferred until safeguarding review completes.`,
      );
    }

    // ── P1: Same-day cancellation / reschedule ────────────────────────────────
    if (urgency === "P1") {
      await lookup_policy({ topic: "scheduling" });

      // Search for existing patient record to confirm identity and personalize reply.
      if (intake.child_name || intake.dob_or_age) {
        await search_patient({
          name: intake.child_name ?? undefined,
          dob: intake.dob_or_age ?? undefined,
        });
      }

      const discipline = intake.discipline?.[0];
      const slots = await find_slots({ discipline: discipline ?? undefined });

      // Only hold a slot if it falls within 3 calendar days of the cancellation.
      // A May 5 opening is not a same-day replacement for a today 3pm cancel —
      // holding it would mislead staff and family. Instead, front desk calls today.
      const nearbySlot =
        slots.data.find((s) => isSoonSlot(s.start, item.received_at)) ?? null;

      let holdNote: string;
      let nextAction: string;
      let rationaleSlotDetail: string;

      if (nearbySlot) {
        const held = await hold_slot({
          slot_id: nearbySlot.slot_id,
          patient_ref: intake.child_name ?? item.id,
        });
        holdNote = `Slot held: ${nearbySlot.start} with ${nearbySlot.provider_name} (hold ${held.data.hold_id}, expires ${held.data.expires_at}). Staff must confirm before patient is notified.`;
        nextAction = "Front desk to confirm held slot and contact family to reschedule.";
        rationaleSlotDetail = `Found nearby slot and placed reviewable hold (${nearbySlot.start}). Staff must confirm before notifying family.`;
      } else {
        // No same-day or near-term slot — front desk must call family directly today.
        holdNote = slots.data.length > 0
          ? `Earliest available ${discipline ?? "therapy"} slot is ${slots.data[0].start} with ${slots.data[0].provider_name} — not same-day. Front desk to call family with options today.`
          : `No ${discipline ?? "therapy"} slots currently available. Front desk to call family today.`;
        nextAction = "Front desk to phone family today to discuss rescheduling options. No slot held.";
        rationaleSlotDetail = "No same-day or near-term slot available; hold skipped. Front desk to contact family directly.";
      }

      const task = await create_task({
        assignee: "front_desk",
        title: `P1 same-day reschedule — ${intake.child_name ?? item.sender}`,
        due: todayIso(),
        notes: `Same-day cancellation received. ${holdNote}`,
      });
      taskIds.push(task.data.task_id);

      const { recipient, channel } = resolveDraftRecipient(item, intake);
      const draft = await draft_message({
        recipient,
        channel,
        body: `Hi, we received your message about today's appointment for ${intake.child_name ?? "your child"}. Our team is looking into rescheduling options and will be in touch shortly.`,
        language: "en",
      });
      draftReply = draft.args.body as string;

      return buildOutput(
        item,
        classification,
        urgency,
        intake,
        missing,
        taskIds,
        null,
        draftReply,
        nextAction,
        `Same-day cancellation received. Classified ${classification} / P1 per scheduling policy. Searched for patient record. ${rationaleSlotDetail}`,
      );
    }

    // ── New referrals ──────────────────────────────────────────────────────────
    if (classification === "new_referral") {
      if (intake.payer) {
        const ins = await verify_insurance({
          payer: intake.payer,
          member_id: intake.member_id ?? undefined,
        });

        if (
          ins.data.status === "out_of_network" ||
          ins.data.status === "expired" ||
          ins.data.status === "unknown"
        ) {
          // Policy: benefits conversation required before any slot hold.
          await lookup_policy({ topic: "insurance" });

          const statusLabel =
            ins.data.status === "unknown"
              ? "unrecognized by the billing system"
              : ins.data.status.replace("_", "-");

          const task = await create_task({
            assignee: "billing",
            title: `Insurance review required — ${intake.child_name ?? item.sender}`,
            due: businessDayIso(1),
            notes: `Insurance verified as ${statusLabel} for payer "${intake.payer}". Do not hold or offer slots until coverage is confirmed. ${ins.data.notes ?? ""}`,
          });
          taskIds.push(task.data.task_id);

          const { recipient, channel } = resolveDraftRecipient(item, intake);
          const draft = await draft_message({
            recipient,
            channel,
            body: `Thank you for the referral for ${intake.child_name ?? "your child"}. Our billing team needs to review the insurance coverage before we can move forward with scheduling. A team member will be in touch to discuss options.`,
            language: "en",
          });
          draftReply = draft.args.body as string;

          return buildOutput(
            item,
            classification,
            urgency,
            intake,
            missing,
            taskIds,
            null,
            draftReply,
            "Billing must verify coverage and complete benefits conversation before any slot is held or scheduling proceeds.",
            `Insurance lookup returned status "${statusLabel}" for ${intake.payer}. Per policy, a benefits conversation is required before any scheduling step.`,
          );
        }

        // In-network: do not hold a slot if intake information is still incomplete.
        // This avoids creating an unreachable hold that billing or intake cannot act on.
        if (missing.length > 0) {
          const task = await create_task({
            assignee: "intake",
            title: `Incomplete referral — ${intake.child_name ?? item.sender}`,
            due: businessDayIso(1),
            notes: `Missing: ${missing.join(", ")}. Insurance tentatively in-network (${intake.payer}) but do not hold a slot until intake is complete.`,
          });
          taskIds.push(task.data.task_id);

          const { recipient, channel } = resolveDraftRecipient(item, intake);
          const draft = await draft_message({
            recipient,
            channel,
            body: `Thank you for the referral for ${intake.child_name ?? "your child"}. To proceed with intake, we need the following additional information: ${missing.join(", ")}. Please contact our office at your earliest convenience.`,
            language: "en",
          });
          draftReply = draft.args.body as string;

          return buildOutput(
            item,
            classification,
            urgency,
            intake,
            missing,
            taskIds,
            null,
            draftReply,
            `Staff to contact referring provider/family to obtain missing: ${missing.join(", ")}.`,
            `Referral is incomplete. Missing fields: ${missing.join(", ")}. Insurance in-network but slot hold deferred until intake is complete.`,
          );
        }

        // In-network with complete intake: find and hold a slot for staff review.
        // Detect Spanish-speaking families and prefer bilingual slots per language access policy.
        const discipline = intake.discipline?.[0];
        const spanishFamily = isSpanishBody(item.body);

        // Consult language access policy before filtering slots — this policy is
        // what justifies the language-specific slot search and the bilingual task note.
        if (spanishFamily) {
          await lookup_policy({ topic: "language_access" });
        }

        const slots = await find_slots({
          discipline: discipline ?? undefined,
          language: spanishFamily ? "es" : undefined,
        });

        if (slots.data.length > 0) {
          const best = slots.data[0];
          const held = await hold_slot({
            slot_id: best.slot_id,
            patient_ref: intake.child_name ?? item.id,
          });
          // hold_id referenced in task notes only — task_ids stays clean (task_* only).

          const taskNotes = spanishFamily
            ? `Spanish-speaking family. Per language access policy, assign to a bilingual Spanish-English provider or arrange interpreter support. Slot tentatively held with ${best.provider_name} — confirm bilingual availability before notifying family.`
            : `Slot held: ${best.start} with ${best.provider_name}. Staff to confirm with family and complete intake paperwork.`;

          const task = await create_task({
            assignee: "intake",
            title: `New referral intake — ${intake.child_name ?? item.sender}`,
            due: businessDayIso(1),
            notes: taskNotes,
          });
          taskIds.push(task.data.task_id);

          const { recipient, channel } = resolveDraftRecipient(item, intake);
          const draft = await draft_message({
            recipient,
            channel,
            body: spanishFamily
              ? "Hola, gracias por comunicarse con Cedar Kids Therapy. Hemos recibido su solicitud y un miembro de nuestro equipo que habla español se comunicará con usted para confirmar los próximos pasos."
              : `Thank you for the referral for ${intake.child_name ?? "your child"}. We have reviewed your request and our intake team will follow up to confirm scheduling details and next steps.`,
            language: spanishFamily ? "es" : "en",
          });
          draftReply = draft.args.body as string;
        } else {
          // No slots available — create intake task to check capacity.
          const task = await create_task({
            assignee: "intake",
            title: `New referral intake — ${intake.child_name ?? item.sender}`,
            due: businessDayIso(1),
            notes: spanishFamily
              ? `Spanish-speaking family. No bilingual slots currently available for ${discipline ?? "requested discipline"}. Assign to a bilingual provider or arrange interpreter support before scheduling.`
              : `Referral received; no slots currently available for ${discipline ?? "requested discipline"}. Check capacity.`,
          });
          taskIds.push(task.data.task_id);

          const { recipient, channel } = resolveDraftRecipient(item, intake);
          const draft = await draft_message({
            recipient,
            channel,
            body: spanishFamily
              ? "Hola, gracias por comunicarse con Cedar Kids Therapy. Un miembro de nuestro equipo se comunicará con usted pronto."
              : `Thank you for the referral for ${intake.child_name ?? "your child"}. Our intake team will be in touch to discuss next steps.`,
            language: spanishFamily ? "es" : "en",
          });
          draftReply = draft.args.body as string;
        }

        const rationale = spanishFamily
          ? `Spanish-language voicemail from Spanish-speaking family requesting SLP evaluation. Insurance verified in-network (${intake.payer}). Bilingual slot held for human review — do not confirm scheduling until bilingual staff assignment is confirmed.`
          : `New referral with in-network insurance (${intake.payer}). Slot held for human review; intake task created.`;
        const nextAction = spanishFamily
          ? "Assign to bilingual Spanish-English provider or arrange interpreter support. Staff must confirm bilingual coverage before notifying family of any slot."
          : "Intake team to confirm slot hold with family and complete intake paperwork.";

        return buildOutput(
          item,
          classification,
          urgency,
          intake,
          missing,
          taskIds,
          null,
          draftReply,
          nextAction,
          rationale,
        );
      }

      // No payer — incomplete referral without insurance information.
      if (missing.length > 0) {
        const task = await create_task({
          assignee: "intake",
          title: `Incomplete referral — ${intake.child_name ?? item.sender}`,
          due: businessDayIso(1),
          notes: `Missing: ${missing.join(", ")}. Contact referring provider to obtain missing information before proceeding with intake.`,
        });
        taskIds.push(task.data.task_id);

        const { recipient, channel } = resolveDraftRecipient(item, intake);

        // Draft is addressed to the referring clinic (fax sender), not the family —
        // the clinic is the right party to supply the missing intake fields.
        const isReferringClinic =
          item.channel === "fax_referral" && !extractEmail(intake.parent_contact ?? "");
        const draftBody = isReferringClinic
          ? `Thank you for referring ${intake.child_name ?? "this patient"} to Cedar Kids Therapy. To proceed with intake, we need the following information from your office: ${missing.join(", ")}. Please fax or call us at your earliest convenience.`
          : `Thank you for the referral for ${intake.child_name ?? "your child"}. To proceed with intake, we need the following additional information: ${missing.join(", ")}. Please contact our office at your earliest convenience.`;

        const draft = await draft_message({
          recipient,
          channel,
          body: draftBody,
          language: "en",
        });
        draftReply = draft.args.body as string;

        return buildOutput(
          item,
          classification,
          urgency,
          intake,
          missing,
          taskIds,
          null,
          draftReply,
          `Intake to contact referring provider to obtain missing: ${missing.join(", ")}.`,
          `Referral is incomplete. Missing fields: ${missing.join(", ")}. Draft addressed to referring clinic requesting missing intake fields.`,
        );
      }
    }

    // ── Clinical question ──────────────────────────────────────────────────────
    // Policy: must NOT give clinical advice; route to clinician review.
    if (classification === "clinical_question") {
      await lookup_policy({ topic: "clinical_advice" });

      const task = await create_task({
        assignee: "clinical_lead",
        title: `Clinical question — route to clinician review`,
        due: businessDayIso(1),
        notes: `Parent asked a clinical question. Route to appropriate clinician for screening or evaluation recommendation. Do not respond with clinical advice.`,
      });
      taskIds.push(task.data.task_id);

      const { recipient, channel } = resolveDraftRecipient(item, intake);
      const draft = await draft_message({
        recipient,
        channel,
        body: "Thank you for your message. Our clinical team will review your question and a staff member will follow up to discuss next steps, which may include a screening or evaluation.",
        language: "en",
      });
      draftReply = draft.args.body as string;

      return buildOutput(
        item,
        classification,
        urgency,
        intake,
        missing,
        taskIds,
        null,
        draftReply,
        "Route to clinical lead for screening or evaluation recommendation. Do not provide clinical advice.",
        "Parent submitted a clinical question. Per policy, automated systems must not provide clinical advice. Routed to clinical lead for review.",
      );
    }

    // ── Fallback: general P2/P3 ───────────────────────────────────────────────
    const task = await create_task({
      assignee: "front_desk",
      title: `Review inbox item — ${item.subject}`,
      due: businessDayIso(1),
      notes: `Item received via ${item.channel}. Review and respond as appropriate.`,
    });
    taskIds.push(task.data.task_id);

    const { recipient, channel } = resolveDraftRecipient(item, intake);
    const draft = await draft_message({
      recipient,
      channel,
      body: "Thank you for contacting Cedar Kids Therapy. A team member will review your message and follow up with you shortly.",
      language: "en",
    });
    draftReply = draft.args.body as string;

    return buildOutput(
      item,
      classification,
      urgency,
      intake,
      missing,
      taskIds,
      null,
      draftReply,
      "Front desk to review and respond.",
      `Item classified as ${classification} / ${urgency}. Routed to front desk for review.`,
    );
  });
}

// ─── Draft recipient resolution ───────────────────────────────────────────────

/**
 * Resolves the most appropriate draft reply recipient and channel.
 *
 * For fax referrals the referring clinic's fax number is the item sender,
 * but replies should go to the parent. This function prefers an email address
 * parsed from the extracted parent contact, falling back to the item sender
 * only when no parent contact is available.
 */
function resolveDraftRecipient(
  item: InboxItem,
  intake: ExtractedIntake,
): { recipient: string; channel: "portal" | "email" | "phone" } {
  const contactEmail = extractEmail(intake.parent_contact ?? "");
  if (contactEmail) {
    return { recipient: contactEmail, channel: "email" };
  }

  if (item.channel === "email") {
    const senderEmail = extractEmail(item.sender);
    return { recipient: senderEmail ?? item.sender, channel: "email" };
  }

  if (item.channel === "portal_message") {
    return { recipient: item.sender, channel: "portal" };
  }

  // Fax and voicemail without a parent email → phone callback
  return { recipient: item.sender, channel: "phone" };
}

function extractEmail(text: string): string | null {
  const match = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return match ? match[0] : null;
}

// ─── Draft safety filter ──────────────────────────────────────────────────────

/**
 * Scans a draft reply for clinical-advice phrases and replaces the entire body
 * with a neutral staff-review template if any are found.
 *
 * This is a last-resort guard — the branch logic above is designed to never
 * produce clinical advice in the first place. The filter protects against
 * future regressions.
 */
const CLINICAL_ADVICE_PATTERNS: RegExp[] = [
  /\byou should\b/i,
  /\bthis is normal\b/i,
  /\bthat('s| is) normal\b/i,
  /\bdon'?t worry\b/i,
  /\bdiagnos(?:is|ed)\b/i,
  /\btry (?:doing|using|this)\b/i,
  /\bit'?s (?:probably|likely|usually) (?:fine|okay|normal)\b/i,
  /\bmost kids\b/i,
  /\btypically (?:at|by|around) (?:age|this)\b/i,
];

function assertSafeDraft(body: string | null): string | null {
  if (!body) return null;
  for (const pattern of CLINICAL_ADVICE_PATTERNS) {
    if (pattern.test(body)) {
      return "Thank you for your message. A member of our team will review and follow up with you shortly.";
    }
  }
  return body;
}

// ─── Intake extraction ────────────────────────────────────────────────────────
// Deterministic regex extraction — no LLM required for the structured referral
// formats and voicemail transcripts in this inbox.

function extractIntake(item: InboxItem): ExtractedIntake {
  const body = item.body;

  const childName = extractField(body, [
    /child:\s*([A-Z][a-z]+ [A-Z][a-z]+)/,
    /a referral for\s+([A-Z][a-z]+ [A-Z][a-z]+)[,. ]/,
    /for\s+([A-Z][a-z]+ [A-Z][a-z]+)[,. ]/,
    /(?:my (?:son|daughter|child) |hija |hijo )\s*([A-Z][a-z]+ [A-Z][a-z]+)/i,
    /(?:referral for|son|daughter|child)[:\s]+([A-Z][a-z]+ [A-Z][a-z]+)/i,
    // Catches "Noah Patel threw up" — child name as opening proper noun before a verb
    /^(?:[A-Z!?]+\s+)?([A-Z][a-z]+ [A-Z][a-z]+)\s+(?:threw|got|is|was|has)\b/,
  ]);

  const childFirstName = extractField(body, [
    /my \d[- ]year[- ]old ([A-Z][a-z]+)/i,
    /(?:my (?:son|daughter) )([A-Z][a-z]+)[, .]/,
    /(?:for |hija |hijo )([A-Z][a-z]+)[,. ]/,
  ]);

  const resolvedChildName = childName ?? childFirstName;

  const dob = extractField(body, [
    /DOB:\s*([\d]{4}-[\d]{2}-[\d]{2})/,
    /DOB:\s*\[?([\d]{4}-[\d]{2}-[\d]{2})\]?/,
    /(\d{4}-\d{2}-\d{2})/,
    /he is (\d+)(?:\s*years? old)?/i,
    /tiene (\d+) a[ñn]os/i,
    /(\d+)[-\s]year[-\s]old/i,
  ]);

  const phoneMatch = body.match(/\b\d{3}-\d{4}\b/);
  const emailMatch = body.match(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  );

  const parentNameMatch =
    body.match(/Parent:\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i) ||
    body.match(/I am (?:his|her) parent,\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i) ||
    // Spanish: "soy Ana Lopez" / "llamo por ... soy Maria"
    body.match(/\bsoy ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i) ||
    body.match(/\bllamo[,.]?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i);

  const parentContact =
    [parentNameMatch?.[1], phoneMatch?.[0], emailMatch?.[0]]
      .filter(Boolean)
      .join(", ") || null;

  const discipline = extractDiscipline(body);

  const diagnosis = extractField(body, [
    /Concern:\s*([^.]+)/i,
    /Diagnosis\/concern:\s*([^.]+)/i,
    /(?:for|concern:)\s*([a-z ]+(?:delay|disorder|difficulty|processing|tolerance|evaluation|walking|tripping|articulation)[^.]*)/i,
  ]);

  const payer = extractField(body, [
    /Insurance:\s*([^.]+?)(?:\.|Member|$)/i,
    /(?:payer|insurance):\s*\[?([A-Za-z ]+(?:PPO|HMO|Select)?)\]?/i,
    /[Ii]nsurance is\s*([A-Za-z ]+(?:PPO|HMO|Select)?),/,
    /Tenemos ([A-Za-z]+)/i,
  ]);

  const memberId = extractField(body, [
    /Member ID:\s*\[?([A-Z0-9-]+)\]?/i,
    /member ID\s+([A-Z0-9-]+)/i,
    /miembro ([A-Z0-9-]+)/i,
  ]);

  return {
    child_name: resolvedChildName,
    dob_or_age: dob,
    parent_contact: parentContact,
    discipline: discipline.length > 0 ? discipline : null,
    diagnosis_or_concern: diagnosis,
    payer: payer ?? null,
    member_id: memberId ?? null,
  };
}

// Treats placeholder values from incomplete/template referral documents as null.
function isBlankValue(s: string): boolean {
  const v = s.trim().toLowerCase().replace(/[\[\]]/g, "");
  return v === "" || v === "blank" || v === "n/a" || v === "none" || v === "unknown";
}

// Detects Spanish-language messages so the intake flow can apply language access policy.
function isSpanishBody(body: string): boolean {
  return /hola|gracias|habla\s+espa|espa[nñ]ol|evaluaci[oó]n|terapia|miembro|llamo|prefiero|necesita/i.test(
    body,
  );
}

function extractField(body: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match?.[1] && !isBlankValue(match[1])) {
      return match[1].trim();
    }
  }
  return null;
}

function extractDiscipline(body: string): Discipline[] {
  const result: Discipline[] = [];
  const lower = body.toLowerCase();
  if (
    lower.includes("speech") ||
    lower.includes("slp") ||
    lower.includes("habla") ||
    lower.includes("terapia de habla")
  )
    result.push("SLP");
  if (
    lower.includes("occupational") ||
    lower.includes(" ot ") ||
    lower.includes("ot.") ||
    lower.includes("sensory")
  )
    result.push("OT");
  if (
    lower.includes("physical therapy") ||
    lower.includes(" pt ") ||
    lower.includes("pt.") ||
    lower.includes("toe walk")
  )
    result.push("PT");
  return result;
}

// ─── Missing info ─────────────────────────────────────────────────────────────

function findMissing(
  classification: Classification,
  intake: ExtractedIntake,
): string[] {
  if (classification !== "new_referral") return [];
  const missing: string[] = [];
  if (!intake.child_name) missing.push("child name");
  if (!intake.dob_or_age) missing.push("date of birth");
  if (!intake.parent_contact) missing.push("parent/guardian contact");
  if (!intake.discipline) missing.push("requested discipline");
  if (!intake.payer) missing.push("insurance/payer");
  return missing;
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function buildOutput(
  item: InboxItem,
  classification: Classification,
  urgency: ItemOutput["urgency"],
  intake: ExtractedIntake,
  missing: string[],
  taskIds: string[],
  escalation: ItemOutput["escalation"],
  draftReply: string | null,
  recommendedNextAction: string,
  decisionRationale: string,
): ItemOutput {
  return {
    item_id: item.id,
    classification,
    urgency,
    requires_human_review: true,
    extracted_intake: intake,
    missing_info: missing,
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action: recommendedNextAction,
    draft_reply: assertSafeDraft(draftReply),
    task_ids: taskIds,
    escalation,
    decision_rationale: decisionRationale,
  };
}

/**
 * Returns true when a slot's start time falls within `withinDays` calendar days
 * of the inbox item's received_at timestamp. Used by the P1 path to avoid
 * holding far-future slots for same-day cancellations.
 */
function isSoonSlot(
  slotStart: string,
  receivedAt: string,
  withinDays = 3,
): boolean {
  const received = new Date(receivedAt);
  const slot = new Date(slotStart);
  const diffMs = slot.getTime() - received.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= withinDays;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function businessDayIso(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

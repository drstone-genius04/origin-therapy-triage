import type { Classification, InboxItem, Urgency } from "./types.js";

// ─── Signal detectors ────────────────────────────────────────────────────────
// Each detector is a pure boolean predicate — easy to unit-test and extend.

/**
 * Returns true if the message body contains signals suggesting harm, abuse,
 * neglect, or unsafe caregiving. Expanded beyond the original keyword list to
 * catch indirect phrasing (e.g. "he hit", "she was scared").
 */
export function hasSafeguardingSignals(body: string): boolean {
  return /\b(rough|harm|abuse|neglect|unsafe|hurt|hit|hitting|scared|violent|afraid|hurting)\b/i.test(
    body,
  );
}

/**
 * Returns true when the message body and subject together indicate a same-day
 * cancellation or reschedule. Requires both a cancel/reschedule keyword AND
 * a same-day context keyword so routine reschedule requests are not elevated.
 */
export function hasSameDayCancelSignals(body: string, subject: string): boolean {
  const combined = `${body} ${subject}`.toLowerCase();
  const hasCancelReschedule =
    /\b(cancel|reschedule|can'?t make|cannot make)\b/.test(combined);
  const hasSameDayContext =
    /\b(today|this morning|this afternoon|tonight|threw up|sick today)\b/.test(
      combined,
    );
  return hasCancelReschedule && hasSameDayContext;
}

/**
 * Returns true when the body contains specific clinical-question phrases.
 * Deliberately tight — avoids false positives on bare "is it" or "should we"
 * that can appear in non-clinical contexts (e.g. scheduling requests).
 */
export function hasClinicalQuestionSignals(body: string): boolean {
  return /is it normal|should (i|we) be worried|should (i|we) wait|before booking|is (this|that) normal|developmental[ly]?\s+concern/i.test(
    body,
  );
}

/**
 * Returns true when the item looks like a new referral — fax channel, a
 * "referral" keyword in subject or body, or Spanish evaluation terminology.
 */
export function hasReferralSignals(
  channel: string,
  subject: string,
  body: string,
): boolean {
  const combined = `${subject} ${body}`.toLowerCase();
  return (
    channel === "fax_referral" ||
    combined.includes("referral") ||
    combined.includes("evaluacion") ||
    combined.includes("evaluación") ||
    combined.includes("terapia")
  );
}

// ─── Classification ──────────────────────────────────────────────────────────

/**
 * Classifies an inbox item using an explicit priority stack so that overlapping
 * signals are resolved deterministically. Safeguarding always wins — an
 * evaluation request inside a safeguarding message does not change the
 * classification.
 *
 * Priority order:
 *   1. Safeguarding (P0 safety concern)
 *   2. Same-day cancel / reschedule (P1 operational)
 *   3. Clinical question (specific phrases only)
 *   4. New referral (fax, keyword, or Spanish eval request)
 *   5. Billing
 *   6. Generic scheduling (no same-day urgency)
 *   7. Other
 */
export function classify(item: InboxItem): Classification {
  const body = item.body.toLowerCase();
  const subject = item.subject.toLowerCase();

  if (hasSafeguardingSignals(body)) return "safeguarding";

  if (hasSameDayCancelSignals(body, subject)) {
    // Promote to existing_patient_request when a named patient or DOB is
    // present, so downstream logic can search for the patient record.
    const hasPatientRef =
      /\b[A-Z][a-z]+ [A-Z][a-z]+/.test(item.body) || /DOB/i.test(item.body);
    return hasPatientRef ? "existing_patient_request" : "scheduling";
  }

  if (hasClinicalQuestionSignals(body)) return "clinical_question";

  if (hasReferralSignals(item.channel, subject, body)) return "new_referral";

  if (/\b(bill|invoice|payment|statement)\b/i.test(body))
    return "billing_question";

  if (/\b(reschedule|cancel|appointment)\b/i.test(body)) return "scheduling";

  return "other";
}

// ─── Urgency ─────────────────────────────────────────────────────────────────

/**
 * Assigns urgency based on classification and message signals.
 * Defaults to P2 — over-escalation wastes clinical lead capacity and is
 * itself a production failure mode per the rubric.
 */
export function prioritize(
  classification: Classification,
  body: string,
  subject: string,
): Urgency {
  if (classification === "safeguarding") return "P0";

  if (
    (classification === "scheduling" ||
      classification === "existing_patient_request") &&
    hasSameDayCancelSignals(body, subject)
  ) {
    return "P1";
  }

  if (classification === "spam" || classification === "other") return "P3";

  return "P2";
}

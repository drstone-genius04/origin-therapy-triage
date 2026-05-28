import Anthropic from "@anthropic-ai/sdk";
import type { InboxItem } from "./types.js";

/**
 * Result of the combined rules + LLM safeguarding assessment.
 * sources records which detectors fired so rationale text can say so.
 * LLM calls are intentionally outside src/tools.ts and never appear in tools_called[].
 */
export interface SafeguardingAssessment {
  is_safeguarding: boolean;
  reason: string;
  sources: Array<"rules" | "llm">;
}

interface LlmSafeguardingJson {
  is_safeguarding: boolean;
  reason: string;
}

const MODEL = "claude-haiku-4-20250514";

/**
 * Combines keyword rules with an optional Anthropic safeguarding classifier.
 *
 * Merge policy: rules OR llm.is_safeguarding
 *   - A keyword hit alone is sufficient to trigger P0.
 *   - An LLM hit alone is also sufficient — this is the improvement over rules-only.
 *   - If the API key is absent or the call throws, fall back to rules silently.
 */
export async function assessSafeguarding(
  item: InboxItem,
  rulesFlagged: boolean,
): Promise<SafeguardingAssessment> {
  const sources: Array<"rules" | "llm"> = [];
  if (rulesFlagged) sources.push("rules");

  let llmFlagged = false;
  let llmReason = "";

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    try {
      const result = await runLlmClassifier(item, apiKey);
      llmFlagged = result.is_safeguarding;
      llmReason = result.reason;
      if (llmFlagged) sources.push("llm");
    } catch {
      // API unavailable — rules-only path continues without interruption.
    }
  }

  const is_safeguarding = rulesFlagged || llmFlagged;

  const reason = buildReason(rulesFlagged, llmFlagged, llmReason);

  return { is_safeguarding, reason, sources };
}

async function runLlmClassifier(
  item: InboxItem,
  apiKey: string,
): Promise<LlmSafeguardingJson> {
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 150,
    temperature: 0,
    system: `You are a safeguarding triage classifier for Cedar Kids Therapy, a pediatric practice.
Determine whether an inbox message suggests harm, abuse, neglect, or unsafe caregiving toward a child.
Do NOT flag scheduling, referrals, clinical development questions, or illness unless they also contain a safeguarding concern.
Respond with JSON only — no markdown, no extra text:
{"is_safeguarding": boolean, "reason": "one sentence if true, empty string if false"}`,
    messages: [
      {
        role: "user",
        content: `Channel: ${item.channel}\nSubject: ${item.subject}\nBody:\n${item.body}`,
      },
    ],
  });

  const text =
    response.content[0]?.type === "text" ? response.content[0].text.trim() : "";

  return parseLlmJson(text);
}

function parseLlmJson(text: string): LlmSafeguardingJson {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { is_safeguarding: false, reason: "" };

  try {
    const parsed = JSON.parse(match[0]) as Partial<LlmSafeguardingJson>;
    return {
      is_safeguarding: Boolean(parsed.is_safeguarding),
      reason: typeof parsed.reason === "string" ? parsed.reason.trim() : "",
    };
  } catch {
    return { is_safeguarding: false, reason: "" };
  }
}

function buildReason(
  rulesFlagged: boolean,
  llmFlagged: boolean,
  llmReason: string,
): string {
  if (rulesFlagged && llmFlagged) {
    return `Keyword rules and LLM classifier both detected safeguarding concern. LLM: ${llmReason}`;
  }
  if (llmFlagged) {
    return llmReason || "LLM classifier detected possible harm or unsafe caregiving.";
  }
  if (rulesFlagged) {
    return "Message contains language suggesting possible harm or unsafe caregiving (keyword rules).";
  }
  return "";
}

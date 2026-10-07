/**
 * SAP C4C — "Draft with Ask C4S" integration.
 *
 * Called from a Custom Action in Cloud Applications Studio. The action
 * passes the ticket ObjectID + style hint; the server pulls the ticket
 * (canonical mapper), grabs the last few notes for context, asks Claude
 * to write a Work Description in field-service tone, and returns the
 * text. The C4C action then writes that into `WorkDescription` and
 * persists on save.
 *
 * Design notes:
 *  - Pure function over the shim's existing primitives. No new SAP calls
 *    that aren't already wired.
 *  - Three "styles" — concise / detailed / checklist — let the C4C
 *    button offer the FSE a tone choice without changing the endpoint.
 *  - The system prompt is intentionally narrow (one job: draft a Work
 *    Description). General-purpose Companion chat uses a different prompt.
 *  - Output is plain text with no markdown — C4C's WorkDescription is a
 *    free-text field and renders markdown literally.
 */

import { chat } from "../chat.js";
import { getCanonicalTicket } from "../modules/service/tickets.js";
import { getTicketNotes } from "../modules/service/history.js";

export type DraftStyle = "concise" | "detailed" | "checklist";

export type DraftRequest = {
  objectId: string;
  /** Defaults to "concise". */
  style?: DraftStyle;
  /** Reserved for future use — today only WorkDescription is supported. */
  field?: string;
};

export type DraftResult = {
  ok: boolean;
  text?: string;
  style: DraftStyle;
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
};

function styleInstruction(style: DraftStyle): string {
  switch (style) {
    case "concise":
      return (
        "Write 2–4 short sentences in plain text. Lead with the symptom, " +
        "then what the FSE will check or do. No bullet points, no markdown."
      );
    case "detailed":
      return (
        "Write a single paragraph (5–8 sentences) in plain text covering: " +
        "symptom, likely root cause, planned action, parts needed, verification. " +
        "Professional but readable. No bullet points, no markdown."
      );
    case "checklist":
      return (
        "Write a numbered checklist (1. 2. 3. ...) of the steps the FSE " +
        "will perform on-site. 4–8 steps. Each step is one short imperative " +
        "sentence. Plain text only, no markdown."
      );
  }
}

const SYSTEM_BASE = `You are Ask C4S drafting a Work Description for a field-service technician dispatched to fix the ticket below.

The Work Description is a free-text field in SAP C4C that the technician (and later, the customer) will read. It must:
- Be specific to the equipment and symptom on this ticket (no boilerplate)
- Reference the customer's product/serial when known
- Avoid inventing details that aren't in the context
- Be safe to send to the customer (no internal speculation, no PII beyond what's already on the ticket)
- Be plain text — no markdown, no bold, no headers

Do not include any preamble like "Here is the draft" — output ONLY the work description text itself, ready to paste into the field.`;

/** Build a compact context block from the canonical ticket + recent notes. */
async function buildContext(objectId: string): Promise<string> {
  const lines: string[] = [];
  try {
    const t = await getCanonicalTicket({ objectId });
    lines.push(`Ticket ${t.displayId ?? t.externalId} — ${t.title}`);
    if (t.lifecycle) lines.push(`Lifecycle: ${t.lifecycle}`);
    if (t.priorityBucket) lines.push(`Priority: ${t.priorityBucket}`);
    if (t.customerName) lines.push(`Customer: ${t.customerName}`);
    if (t.serialId) lines.push(`Serial: ${t.serialId}`);
    if (t.productName || t.productId) lines.push(`Product: ${t.productName ?? t.productId}`);
  } catch (err) {
    lines.push(`Ticket ${objectId} — (canonical mapping failed: ${(err as Error).message})`);
  }

  // Recent notes — they carry the customer's words, FSE observations, etc.
  // Limit to the 3 most recent to keep the prompt cheap.
  try {
    const notesResp = (await getTicketNotes({ objectId, top: 3 })) as any;
    const notes: any[] = notesResp?.notes ?? notesResp?.results ?? [];
    if (notes.length > 0) {
      lines.push("\nRecent notes (newest first):");
      for (const n of notes.slice(0, 3)) {
        const type = String(n.TypeCodeText ?? n.typeCodeText ?? "Note");
        const text = String(n.Text ?? n.text ?? "")
          .replace(/<[^>]+>/g, "")
          .replace(/\r\n|\\r\\n|\\n/g, "\n")
          .trim()
          .slice(0, 400);
        if (text) lines.push(`[${type}] ${text}`);
      }
    }
  } catch {
    /* notes are nice-to-have, not blocking */
  }

  return lines.join("\n");
}

export async function draftWorkDescription(req: DraftRequest): Promise<DraftResult> {
  const style: DraftStyle = req.style ?? "concise";
  if (!req.objectId?.trim()) {
    return { ok: false, style, error: "objectId is required." };
  }

  const context = await buildContext(req.objectId.trim());
  const system = `${SYSTEM_BASE}\n\nStyle: ${styleInstruction(style)}\n\nTicket context:\n${context}`;

  const reply = await chat({
    messages: [
      {
        role: "user",
        content: `Draft a Work Description for this ticket. Output only the description text — nothing else.`,
      },
    ],
    // Pass the composed system as `context` so chat() prepends it under
    // its DEFAULT_SYSTEM. (We could expose a system override later, but
    // this works fine and keeps chat() generic.)
    context: system,
  });

  if (!reply.ok || !reply.text) {
    return {
      ok: false,
      style,
      error: reply.error ?? "LLM returned no text.",
      provider: reply.provider,
      model: reply.model,
    };
  }

  // Strip any accidental "Here is the draft:" preambles the model might add.
  const cleaned = reply.text
    .replace(/^(here(?:'s| is) (?:the |a )?(?:drafted? |sample )?(?:work )?description[:\s—-]+)/i, "")
    .trim();

  return {
    ok: true,
    text: cleaned,
    style,
    provider: reply.provider,
    model: reply.model,
    inputTokens: reply.usage?.inputTokens,
    outputTokens: reply.usage?.outputTokens,
  };
}

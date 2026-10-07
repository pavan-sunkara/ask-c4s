/**
 * Embeddings + RAG helpers for ticket history search.
 *
 * Uses OpenAI's `text-embedding-3-small` (1536-d, $0.00002 / 1K tokens) by
 * default — it's cheap, fast, and the Node fetch path is identical to chat.
 * If `OPENAI_API_KEY` isn't set, the helpers return an empty-vector marker
 * so the UI can render a "configure OpenAI to enable" message instead of
 * crashing.
 *
 * Cosine similarity runs in-process against the embeddings stored in
 * ticket_embeddings. At up to ~10k cached tickets per tenant this is fast
 * (<50ms cold, <5ms warm). For larger corpora swap in sqlite-vec or a
 * dedicated vector DB.
 */

import {
  cosineSimilarity,
  countTenantEmbeddings,
  hasFreshEmbedding,
  loadTenantEmbeddings,
  storeTicketEmbedding,
} from "./cache.js";
import { getTenantId } from "./c4cClient.js";
import { getSettingString } from "./settings.js";

const DEFAULT_MODEL = "text-embedding-3-small";

function resolveOpenAIKey(): string | undefined {
  try {
    return (
      getSettingString("ai.openai_key") ||
      process.env.OPENAI_API_KEY ||
      undefined
    );
  } catch {
    return process.env.OPENAI_API_KEY || undefined;
  }
}

function resolveEmbeddingModel(): string {
  try {
    return (
      getSettingString("ai.embedding_model") ||
      process.env.OPENAI_EMBEDDING_MODEL ||
      DEFAULT_MODEL
    );
  } catch {
    return process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_MODEL;
  }
}

export function embeddingsConfigured(): boolean {
  return Boolean(resolveOpenAIKey());
}

/** Generate an embedding vector via the OpenAI API. Returns null if no key. */
export async function generateEmbedding(text: string): Promise<{
  vector: number[];
  model: string;
} | null> {
  const key = resolveOpenAIKey();
  if (!key) return null;
  const model = resolveEmbeddingModel();
  const trimmed = text.trim().slice(0, 8000); // hard cap input length
  if (!trimmed) return null;

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model, input: trimmed }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI embeddings ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const vector = data.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error(`OpenAI embeddings: empty vector in response`);
  }
  return { vector, model };
}

/**
 * Embed + store a ticket's content if not already fresh. Cheap to call
 * — short-circuits when the text hash matches a previously-stored row.
 * Use whenever a ticket is fetched or written; the embedding stays in
 * sync with the cached content.
 */
export async function ensureTicketEmbedding(opts: {
  objectId: string;
  /** Composite text used for similarity — typically title + product + customer + recent notes. */
  text: string;
  /** Optional tenant override; defaults to the active tenant from c4cClient. */
  tenantId?: string;
}): Promise<{ stored: boolean; reason?: string }> {
  const tenantId = opts.tenantId ?? safeTenantId();
  if (!embeddingsConfigured()) {
    return { stored: false, reason: "OPENAI_API_KEY not configured." };
  }
  if (!opts.text.trim()) return { stored: false, reason: "Empty text." };
  if (hasFreshEmbedding(tenantId, opts.objectId, opts.text)) {
    return { stored: false, reason: "Already embedded (hash match)." };
  }
  const result = await generateEmbedding(opts.text);
  if (!result) return { stored: false, reason: "Embedding generation returned null." };
  storeTicketEmbedding({
    tenantId,
    objectId: opts.objectId,
    text: opts.text,
    vector: result.vector,
    model: result.model,
  });
  return { stored: true };
}

export type SimilarTicket = {
  objectId: string;
  similarity: number;
  textPreview: string;
};

export type FindSimilarOptions = {
  /** Free-text query to embed and compare. */
  query: string;
  /** Limit on results. */
  top?: number;
  /** Optional: exclude an objectId from results (useful when scoring "similar to ticket X"). */
  excludeObjectId?: string;
  /** Override tenant. */
  tenantId?: string;
};

/**
 * Embed the query, score every cached embedding, return the top-K by cosine.
 * Intended for the "find similar tickets" panel + the AssistantPanel intent.
 */
export async function findSimilarTickets(opts: FindSimilarOptions): Promise<{
  configured: boolean;
  query: string;
  searched: number;
  results: SimilarTicket[];
  error?: string;
}> {
  const tenantId = opts.tenantId ?? safeTenantId();
  if (!embeddingsConfigured()) {
    return {
      configured: false,
      query: opts.query,
      searched: 0,
      results: [],
      error: "OPENAI_API_KEY not set on the server — embeddings disabled.",
    };
  }
  const stored = countTenantEmbeddings(tenantId);
  if (stored === 0) {
    return {
      configured: true,
      query: opts.query,
      searched: 0,
      results: [],
      error:
        "No ticket embeddings yet. Look up a few tickets (each lookup auto-embeds) and try again.",
    };
  }

  const queryEmb = await generateEmbedding(opts.query);
  if (!queryEmb) {
    return {
      configured: true,
      query: opts.query,
      searched: 0,
      results: [],
      error: "Failed to embed the query.",
    };
  }

  const all = loadTenantEmbeddings(tenantId);
  const scored = all
    .filter((e) => e.objectId !== opts.excludeObjectId)
    .map((e) => ({
      objectId: e.objectId,
      textPreview: e.textPreview,
      similarity: cosineSimilarity(queryEmb.vector, e.vector),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, opts.top ?? 5);

  return {
    configured: true,
    query: opts.query,
    searched: all.length,
    results: scored,
  };
}

function safeTenantId(): string {
  try {
    return getTenantId() || "default";
  } catch {
    return "default";
  }
}

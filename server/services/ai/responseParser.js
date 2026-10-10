// Strict normalisation of provider output (Phase 8).
//
// Model output is UNTRUSTED INPUT. It is a string a remote system produced, and
// it may be malformed JSON, JSON of the wrong shape, prose wrapped in a code
// fence, an empty reply, or a 4,000-character essay. None of that may reach a
// customer's handset, and none of it may crash a worker.
//
// The contract: either a valid normalised result, or `ok: false` with a reason.
// A caller that gets `ok: false` must not send anything.
'use strict';

// Hard ceiling regardless of configuration — a reply longer than this is a
// malfunction, not a long answer.
const ABSOLUTE_MAX_REPLY = 1600; // 10 GSM-7 segments
const DEFAULT_MAX_REPLY = 320;

// Models are prone to wrapping JSON in ```json fences despite being told not to.
// Tolerating that is not trusting the model — the result is still validated.
function stripCodeFence(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

// Some models emit a preamble before the object. Fall back to the outermost
// {...} span rather than failing the whole generation.
function extractJsonObject(text) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  return text.slice(first, last + 1);
}

function fail(reason) {
  return { ok: false, reason };
}

// Coerce a confidence into [0,1]. Models return 0.8, "0.8", and 80 — all of
// which plainly mean the same thing. Anything uninterpretable yields undefined,
// which the guardrails treat as "no confidence stated".
function normalizeConfidence(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value)) return undefined;
  if (value > 1 && value <= 100) value /= 100; // a percentage
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeBoolean(raw) {
  if (typeof raw === 'boolean') return raw;
  const text = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (['true', 'yes', '1'].includes(text)) return true;
  if (['false', 'no', '0', ''].includes(text)) return false;
  return false; // anything unrecognised is NOT an escalation signal
}

function normalizeUsage(usage = {}) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
  const out = {
    promptTokens: num(usage.promptTokens),
    completionTokens: num(usage.completionTokens),
    totalTokens: num(usage.totalTokens),
  };
  return Object.values(out).every((v) => v === undefined) ? undefined : out;
}

// raw adapter result -> normalised result, or a refusal.
//
//   { ok: true, reply, confidence?, shouldEscalate, reason, usage?, provider, model }
//   { ok: false, reason }
function parseProviderResponse(raw, { maxReplyCharacters = DEFAULT_MAX_REPLY } = {}) {
  if (!raw || typeof raw.text !== 'string') {
    return fail('provider_no_text');
  }

  const cleaned = stripCodeFence(raw.text);
  if (!cleaned) return fail('provider_empty_output');

  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const candidate = extractJsonObject(cleaned);
    if (candidate) {
      try {
        parsed = JSON.parse(candidate);
      } catch (e2) {
        parsed = null;
      }
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('provider_malformed_json');
  }

  const replyRaw = parsed.reply;
  if (typeof replyRaw !== 'string') return fail('provider_missing_reply');

  // Collapse whitespace: a multi-line model answer becomes one SMS body.
  const reply = replyRaw.replace(/\s+/g, ' ').trim();

  const shouldEscalate = normalizeBoolean(parsed.escalate ?? parsed.shouldEscalate);

  // An empty reply is only acceptable when the model is explicitly escalating —
  // then there is deliberately nothing to say and a human takes over.
  if (!reply) {
    return shouldEscalate
      ? {
          ok: true,
          reply: '',
          confidence: normalizeConfidence(parsed.confidence),
          shouldEscalate: true,
          reason: String(parsed.reason || 'model_escalated').slice(0, 200),
          usage: normalizeUsage(raw.usage),
          provider: raw.provider || '',
          model: raw.model || '',
        }
      : fail('provider_empty_reply');
  }

  const ceiling = Math.min(Number(maxReplyCharacters) || DEFAULT_MAX_REPLY, ABSOLUTE_MAX_REPLY);
  if (reply.length > ceiling) {
    // Deliberately NOT truncated. A reply cut mid-sentence is worse than no
    // reply, and over-length output means the model ignored its instructions —
    // which is exactly when a human should look.
    return fail('provider_reply_too_long');
  }

  return {
    ok: true,
    reply,
    confidence: normalizeConfidence(parsed.confidence),
    shouldEscalate,
    reason: String(parsed.reason || '').slice(0, 200),
    usage: normalizeUsage(raw.usage),
    provider: raw.provider || '',
    model: raw.model || '',
  };
}

module.exports = {
  parseProviderResponse,
  normalizeConfidence,
  normalizeBoolean,
  stripCodeFence,
  ABSOLUTE_MAX_REPLY,
  DEFAULT_MAX_REPLY,
};

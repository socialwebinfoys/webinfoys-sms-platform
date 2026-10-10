// Prompt construction (Phase 8).
//
// Pure and deterministic: the same inputs always produce the same two strings.
// No clock, no randomness, no database access — everything it needs is passed
// in. That is what makes it testable, and what makes it possible to state with
// confidence what does and does not leave this server.
//
// WHAT IS SENT: the configured persona, business rules and FAQ; a bounded window
// of recent messages as 'Customer:' / 'Business:' lines; and the inbound message
// being answered.
//
// WHAT IS NEVER SENT: anything from config/env — no Mongo URI, no JWT secret, no
// Twilio credentials, no provider key — and no whole database documents. Only
// the specific fields named below are read, so a new field added to Contact or
// Conversation cannot start leaking into prompts by accident.
'use strict';

// Hard ceilings, independent of configuration. A pathological persona or a
// 5,000-character SMS cannot inflate a request without bound.
const MAX_SECTION_CHARS = 2000;
const MAX_MESSAGE_CHARS = 600;
const DEFAULT_CONTEXT_LIMIT = 10;
const DEFAULT_MAX_REPLY_CHARS = 320;

function clamp(value, limit) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// The contract the model is asked to honour. Kept verbatim and first so that
// behaviour is governed by instructions the operator cannot accidentally
// override from the persona field.
function buildSystemPrompt(aiSettings = {}) {
  const maxChars = aiSettings.maxReplyCharacters || DEFAULT_MAX_REPLY_CHARS;
  const sections = [];

  sections.push(
    [
      'You write SMS replies on behalf of a business.',
      '',
      'Rules you must follow:',
      `- Keep the reply under ${maxChars} characters. It is an SMS, not an email.`,
      '- Write plain text. No markdown, no emoji-only replies, no links unless the context supplies one.',
      '- Only use facts given in the context below. If you do not know, say so and offer a human.',
      '- Never invent prices, dates, availability, order numbers or policies.',
      '- Never ask for payment details, passwords or any other secret.',
      '- If the customer asks for a human, is angry, or raises a legal or medical matter, escalate.',
      '- If you are unsure, prefer escalating over guessing.',
    ].join('\n')
  );

  const persona = clamp(aiSettings.persona, MAX_SECTION_CHARS);
  if (persona) sections.push(`Who you are:\n${persona}`);

  const rules = clamp(aiSettings.businessRules, MAX_SECTION_CHARS);
  if (rules) sections.push(`Business rules:\n${rules}`);

  const faq = clamp(aiSettings.faq, MAX_SECTION_CHARS);
  if (faq) sections.push(`Reference information:\n${faq}`);

  // The response contract. The parser is strict, and this is what it expects.
  sections.push(
    [
      'Respond with a single JSON object and nothing else:',
      '{',
      '  "reply": "the SMS text to send",',
      '  "confidence": 0.0 to 1.0,',
      '  "escalate": true or false,',
      '  "reason": "short explanation, required when escalate is true"',
      '}',
    ].join('\n')
  );

  return sections.join('\n\n');
}

// Renders the thread plus the message being answered.
//
// `messages` is expected newest-first (the order getMessages and the inbox use);
// the newest N are taken and then reversed so the model reads them
// chronologically.
function buildUserPrompt({ inboundBody, messages = [], aiSettings = {} } = {}) {
  const limit = Math.max(1, aiSettings.contextMessageLimit || DEFAULT_CONTEXT_LIMIT);

  const recent = messages
    .slice(0, limit)
    .filter((m) => m && typeof m.body === 'string' && m.body.trim())
    .map((m) => ({
      who: m.direction === 'inbound' ? 'Customer' : 'Business',
      text: clamp(m.body, MAX_MESSAGE_CHARS),
    }))
    .reverse();

  const parts = [];
  if (recent.length > 0) {
    parts.push(
      `Conversation so far (oldest first):\n${recent.map((m) => `${m.who}: ${m.text}`).join('\n')}`
    );
  }
  parts.push(`New message from the customer:\n${clamp(inboundBody, MAX_MESSAGE_CHARS)}`);
  parts.push('Write the reply.');

  return parts.join('\n\n');
}

// Convenience wrapper returning both halves at once.
function buildPrompt({ inboundBody, messages, aiSettings } = {}) {
  return {
    system: buildSystemPrompt(aiSettings),
    user: buildUserPrompt({ inboundBody, messages, aiSettings }),
  };
}

module.exports = {
  buildPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  MAX_SECTION_CHARS,
  MAX_MESSAGE_CHARS,
  DEFAULT_CONTEXT_LIMIT,
};

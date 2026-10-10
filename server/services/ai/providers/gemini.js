// Gemini adapter (Phase 8).
//
// Gemini's API differs from the other two in three ways the adapter absorbs so
// nothing downstream has to know:
//   * the model name is part of the URL, not the body;
//   * the key goes in an x-goog-api-key header rather than a bearer token;
//   * the system prompt is `systemInstruction`, and the reply arrives as
//     candidates[].content.parts[].text rather than a single message string.
'use strict';

const { ProviderError, kindForStatus, kindForNetworkError, safeDetail } = require('./errors');

const NAME = 'gemini';
const DEFAULT_MODEL = 'gemini-1.5-flash';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function generate({ apiKey, model, system, user, timeoutMs, fetchImpl = fetch }) {
  const chosenModel = model || DEFAULT_MODEL;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
    },
  };

  let res;
  try {
    // The key travels as a header, never as a query parameter — a URL can end up
    // in a proxy or access log, and a header is far less likely to.
    res = await fetchImpl(`${BASE}/${encodeURIComponent(chosenModel)}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ProviderError(`Gemini request failed: ${safeDetail(err.message, apiKey)}`, {
      kind: kindForNetworkError(err),
      provider: NAME,
    });
  }

  if (!res.ok) {
    const detail = safeDetail(await res.text().catch(() => ''), apiKey);
    throw new ProviderError(`Gemini returned ${res.status}: ${detail}`, {
      kind: kindForStatus(res.status),
      provider: NAME,
      status: res.status,
    });
  }

  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    throw new ProviderError('Gemini returned a body that is not JSON', {
      kind: 'invalid_request',
      provider: NAME,
    });
  }

  // A response can be blocked by safety filters, in which case there are no
  // candidates at all. That is a definitive refusal, not a transient blip.
  const blockReason = payload?.promptFeedback?.blockReason;
  if (blockReason) {
    throw new ProviderError(`Gemini blocked the prompt: ${safeDetail(blockReason, apiKey)}`, {
      kind: 'invalid_request',
      provider: NAME,
    });
  }

  const parts = payload?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('')
    : '';
  if (!text.trim()) {
    throw new ProviderError('Gemini returned no candidate text', {
      kind: 'temporary',
      provider: NAME,
    });
  }

  return {
    provider: NAME,
    model: chosenModel,
    text,
    usage: {
      promptTokens: payload?.usageMetadata?.promptTokenCount,
      completionTokens: payload?.usageMetadata?.candidatesTokenCount,
      totalTokens: payload?.usageMetadata?.totalTokenCount,
    },
  };
}

module.exports = { name: NAME, defaultModel: DEFAULT_MODEL, generate };

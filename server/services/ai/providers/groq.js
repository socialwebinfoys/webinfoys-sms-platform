// Groq adapter (Phase 8).
//
// Groq exposes an OpenAI-compatible chat-completions API, so the request and
// response shapes match. It is still a separate adapter rather than a parameter
// of the OpenAI one: the endpoint, default model and failure wording differ, and
// keeping them apart means a divergence on either side cannot break the other.
'use strict';

const { ProviderError, kindForStatus, kindForNetworkError, safeDetail } = require('./errors');

const NAME = 'groq';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

async function generate({ apiKey, model, system, user, timeoutMs, fetchImpl = fetch }) {
  const body = {
    model: model || DEFAULT_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' },
  };

  let res;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ProviderError(`Groq request failed: ${safeDetail(err.message, apiKey)}`, {
      kind: kindForNetworkError(err),
      provider: NAME,
    });
  }

  if (!res.ok) {
    const detail = safeDetail(await res.text().catch(() => ''), apiKey);
    throw new ProviderError(`Groq returned ${res.status}: ${detail}`, {
      kind: kindForStatus(res.status),
      provider: NAME,
      status: res.status,
    });
  }

  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    throw new ProviderError('Groq returned a body that is not JSON', {
      kind: 'invalid_request',
      provider: NAME,
    });
  }

  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new ProviderError('Groq returned no message content', {
      kind: 'temporary',
      provider: NAME,
    });
  }

  return {
    provider: NAME,
    model: payload.model || body.model,
    text,
    usage: {
      promptTokens: payload?.usage?.prompt_tokens,
      completionTokens: payload?.usage?.completion_tokens,
      totalTokens: payload?.usage?.total_tokens,
    },
  };
}

module.exports = { name: NAME, defaultModel: DEFAULT_MODEL, generate };

// Phase 9 — rendering the real AI components.
//
// react-dom/server renders the components that ship, with no new dependency and
// no jsdom. What it proves:
//
//   * every job status renders, including one this build does not know;
//   * the actions appear only on a draft that may actually be acted on;
//   * UNTRUSTED TEXT IS ESCAPED — model output, a contact name, a stored reason
//     and an operator's edit all go through React as children;
//   * form controls have labels, and a non-admin gets disabled inputs;
//   * loading, empty and error states exist and say something useful;
//   * a stored API key is never rendered.
//
// Effects do not run during server rendering, so the self-fetching components are
// exercised in their initial state and the data-driven ones are given their data
// as props. No component can reach the network here in any case — the harness
// replaces fetch and XMLHttpRequest with throwing functions.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import AiDraftCard from '../src/components/AiDraftCard.jsx';
import AiSettingsForm from '../src/components/AiSettingsForm.jsx';
import AiConversationPanel from '../src/components/AiConversationPanel.jsx';
import AiAssistant from '../src/pages/AiAssistant.jsx';
import { AuthProvider } from '../src/context/AuthContext.jsx';

const h = React.createElement;
const render = (element) => renderToStaticMarkup(element);
const inRouter = (element) => render(h(MemoryRouter, null, element));
// AiSettingsForm reads the signed-in user's role from the existing auth context.
const asUser = (role, element) => {
  localStorage.setItem('user', JSON.stringify({ _id: 'u1', name: 'Test', role }));
  localStorage.setItem('token', 'test-jwt');
  try {
    return render(h(AuthProvider, null, element));
  } finally {
    localStorage.clear();
  }
};

const JOB = {
  _id: '6a9a77ec9990e8f4bb000001',
  status: 'drafted',
  mode: 'draft',
  draftReply: 'We are open until 6pm today.',
  confidence: 0.91,
  provider: 'openai',
  model: 'gpt-4o-mini',
  reason: 'draft_mode',
  edited: false,
  escalated: false,
  createdAt: '2026-10-01T10:00:00.000Z',
  contact: { _id: 'c1', name: 'Ada Lovelace', phone: '+14155552671' },
  conversation: { _id: 'k1', contactName: 'Ada Lovelace', contactPhone: '+14155552671' },
};

const SETTINGS = {
  enabled: false,
  defaultMode: 'draft',
  provider: 'openai',
  model: 'gpt-4o-mini',
  availableProviders: ['openai', 'groq', 'gemini'],
  defaultModelForProvider: 'gpt-4o-mini',
  persona: 'Be brief and warm.',
  businessRules: 'Never quote prices.',
  faq: 'Q: hours? A: 9-6.',
  escalationKeywords: ['human', 'lawyer'],
  confidenceThreshold: 0.7,
  maxRepliesPerConversation: 3,
  contextMessageLimit: 10,
  maxReplyCharacters: 320,
  apiKey: { configured: true, masked: '••••••••wxyz' },
  encryptionConfigured: true,
};

// ===========================================================================
describe('AiDraftCard — a draft awaiting review', () => {
  const html = () => render(h(AiDraftCard, { job: JOB, maxReplyCharacters: 320 }));

  test('shows the reply text', () => {
    assert.match(html(), /We are open until 6pm today\./);
  });

  test('shows who it is for', () => {
    const out = html();
    assert.match(out, /Ada Lovelace/);
    assert.match(out, /\+14155552671/);
  });

  test('offers all three review actions', () => {
    const out = html();
    assert.match(out, /Approve &amp; send|Approve &#x26; send/);
    assert.match(out, />Edit</);
    assert.match(out, />Discard</);
  });

  test('shows the status and the confidence', () => {
    const out = html();
    assert.match(out, /Awaiting review/);
    assert.match(out, /Confidence 91%/);
  });

  test('every action is a real <button type="button">, not a clickable div', () => {
    const out = html();
    const buttons = out.match(/<button[^>]*>/g) || [];
    assert.ok(buttons.length >= 3, 'expected at least three buttons');
    for (const b of buttons) {
      assert.match(b, /type="button"/, `a button without an explicit type: ${b}`);
    }
  });
});

describe('AiDraftCard — statuses that cannot be acted on', () => {
  // Checks for the CONTROLS, not for the words: an explanation like "Approved and
  // sent by a human" legitimately contains "Approve", and matching prose here
  // would make the test fail on correct output.
  const noActions = (out) => {
    assert.ok(!/<div class="ai-draft-actions">/.test(out), 'the action row appeared on a non-draft');
    assert.ok(!/<button[^>]*>\s*Approve/.test(out), 'an approve button appeared on a non-draft');
    assert.ok(!/<button[^>]*>\s*Discard</.test(out), 'a discard button appeared on a non-draft');
    assert.ok(!/<button[^>]*>\s*Edit</.test(out), 'an edit button appeared on a non-draft');
  };

  test('a sent job shows no actions and says it was sent', () => {
    const out = render(h(AiDraftCard, { job: { ...JOB, status: 'sent', reason: 'approved' } }));
    assert.match(out, /Sent/);
    noActions(out);
  });

  test('a rejected job shows no actions and says it was discarded', () => {
    const out = render(h(AiDraftCard, { job: { ...JOB, status: 'rejected', reason: 'rejected' } }));
    assert.match(out, /Discarded/);
    noActions(out);
  });

  test('a skipped job explains the guardrail in plain words', () => {
    const out = render(h(AiDraftCard, { job: { ...JOB, status: 'skipped', reason: 'opted_out' } }));
    assert.match(out, /opted out of SMS/);
    assert.ok(!/opted_out/.test(out), 'a raw reason token was rendered');
    noActions(out);
  });

  test('a failed job shows its last error', () => {
    const out = render(
      h(AiDraftCard, { job: { ...JOB, status: 'failed', reason: 'max_retries', lastError: 'Twilio unavailable' } })
    );
    assert.match(out, /Twilio unavailable/);
    noActions(out);
  });

  test('a pending job renders without actions', () => {
    const out = render(h(AiDraftCard, { job: { ...JOB, status: 'pending', draftReply: '' } }));
    assert.match(out, /Queued/);
    noActions(out);
  });

  test('an UNKNOWN status still renders, and offers no actions', () => {
    const out = render(h(AiDraftCard, { job: { ...JOB, status: 'teleported' } }));
    assert.match(out, /teleported/);
    noActions(out);
  });

  test('an edited sent job is marked as edited', () => {
    const out = render(
      h(AiDraftCard, {
        job: { ...JOB, status: 'sent', edited: true, approvedBody: 'Human wording.', reason: 'approved_edited' },
      })
    );
    assert.match(out, />Edited</);
    // The approved text is what is shown for a sent job.
    assert.match(out, /Human wording\./);
  });

  test('a job with no confidence does not render "0%"', () => {
    for (const confidence of [undefined, null]) {
      const out = render(h(AiDraftCard, { job: { ...JOB, confidence } }));
      assert.ok(!/Confidence 0%/.test(out), 'a missing confidence rendered as 0%');
      assert.ok(!/Confidence <\/span>/.test(out), 'an empty confidence chip was rendered');
    }
  });

  test('an escalated job is flagged', () => {
    const out = render(h(AiDraftCard, { job: { ...JOB, status: 'escalated', escalated: true } }));
    assert.match(out, />Escalated</);
  });
});

// ===========================================================================
// PART X. Everything the model wrote, everything the customer wrote, and
// everything an operator typed is untrusted. React escapes it; this proves it.
describe('AiDraftCard — untrusted content is escaped (XSS)', () => {
  const PAYLOADS = [
    '<script>alert("xss")</script>',
    '"><img src=x onerror=alert(1)>',
    '<iframe src="javascript:alert(1)"></iframe>',
    "<div onclick=\"alert('x')\">click</div>",
    '<svg/onload=alert(1)>',
    '</textarea><script>fetch("//evil.test")</script>',
    '{{constructor.constructor("alert(1)")()}}',
    '<a href="javascript:alert(1)">link</a>',
  ];

  // The test that matters: no payload may survive as MARKUP. Checking for the
  // substring "onerror=" would fail on correctly escaped output — `&lt;img src=x
  // onerror=alert(1)&gt;` is inert text — so what is asserted instead is that no
  // element from the payload exists, and that the payload never appears verbatim
  // (any payload containing < or " must come back escaped).
  const assertInert = (out, payload, where) => {
    assert.ok(
      !out.includes(payload),
      `${where}: the payload appeared verbatim, so it was not escaped: ${payload}`
    );
    for (const tag of ['script', 'iframe', 'img', 'svg', 'a ', 'a>']) {
      assert.ok(
        !new RegExp(`<${tag.trim()}[\\s>/]`, 'i').test(out),
        `${where}: a <${tag.trim()}> element was created from ${payload}`
      );
    }
    // An inline handler can only be an attribute, which requires an unescaped "<".
    assert.ok(!/<[a-z]+[^>]*\son[a-z]+=/i.test(out), `${where}: an inline event handler exists`);
    assert.ok(!/<[a-z]+[^>]*javascript:/i.test(out), `${where}: a javascript: URL exists`);
  };

  test('a malicious draft body cannot inject markup', () => {
    for (const payload of PAYLOADS) {
      const out = render(h(AiDraftCard, { job: { ...JOB, draftReply: payload } }));
      assertInert(out, payload, 'draft body');
      // It IS still shown, escaped — an operator must see what the model wrote.
      assert.match(out, /&lt;|&gt;|&quot;|&#x27;|alert/);
    }
  });

  test('a malicious contact name cannot inject markup', () => {
    const payload = '<script>alert(1)</script>';
    const out = render(
      h(AiDraftCard, { job: { ...JOB, contact: { _id: 'c1', name: payload, phone: '+1' } } })
    );
    assertInert(out, payload, 'contact name');
    assert.match(out, /&lt;script&gt;/);
  });

  test('a malicious stored reason cannot inject markup', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const out = render(h(AiDraftCard, { job: { ...JOB, status: 'skipped', reason: payload } }));
    assertInert(out, payload, 'reason');
  });

  test('a malicious lastError cannot inject markup', () => {
    const payload = '<script>alert(1)</script>';
    const out = render(h(AiDraftCard, { job: { ...JOB, status: 'failed', lastError: payload } }));
    assertInert(out, payload, 'lastError');
  });

  test('a malicious persona, FAQ or business rule cannot inject markup', () => {
    const payload = '<script>alert("faq")</script>';
    const out = asUser(
      'admin',
      h(AiSettingsForm, {
        settings: { ...SETTINGS, persona: payload, faq: payload, businessRules: payload },
        onSettings() {},
        loading: false,
      })
    );
    assertInert(out, payload, 'settings text');
  });

  test('no AI component uses dangerouslySetInnerHTML', async () => {
    // Asserted against the source, because an escaped render only proves the
    // paths this test happened to exercise.
    const { readFile } = await import('node:fs/promises');
    const files = [
      '../src/components/AiDraftCard.jsx',
      '../src/components/AiSettingsForm.jsx',
      '../src/components/AiConversationPanel.jsx',
      '../src/pages/AiAssistant.jsx',
      '../src/utils/aiPresentation.js',
      '../src/services/aiApi.js',
    ];
    for (const file of files) {
      const raw = await readFile(new URL(file, import.meta.url), 'utf8');
      // Comments are stripped first: these files DISCUSS not using
      // dangerouslySetInnerHTML, and a prose mention is not a use.
      const source = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
      assert.ok(!source.includes('dangerouslySetInnerHTML'), `${file} uses dangerouslySetInnerHTML`);
      assert.ok(!source.includes('innerHTML'), `${file} touches innerHTML`);
      assert.ok(!/\beval\(/.test(source), `${file} uses eval`);
      assert.ok(!/new Function\(/.test(source), `${file} builds a function from a string`);
      // And nothing writes untrusted text into a URL or browser storage.
      assert.ok(!/sessionStorage/.test(source), `${file} uses sessionStorage`);
      assert.ok(!/localStorage/.test(source), `${file} uses localStorage directly`);
    }
  });
});

// ===========================================================================
describe('AiSettingsForm — configuration', () => {
  const adminHtml = () =>
    asUser('admin', h(AiSettingsForm, { settings: SETTINGS, onSettings() {}, loading: false }));

  test('a loading state is shown while settings are fetched', () => {
    const out = asUser('admin', h(AiSettingsForm, { settings: null, onSettings() {}, loading: true }));
    assert.match(out, /Loading AI configuration/);
  });

  test('a load failure shows the error and a retry', () => {
    const out = asUser(
      'admin',
      h(AiSettingsForm, { settings: null, onSettings() {}, loading: false, loadError: 'Could not load AI settings.' })
    );
    assert.match(out, /Could not load AI settings\./);
    assert.match(out, /Try again/);
    assert.match(out, /role="alert"/);
  });

  test('activation is presented separately from configuration', () => {
    const out = adminHtml();
    assert.match(out, /Turn AI on/);
    assert.match(out, /Save changes/);
    // And enabling is explicitly not a send.
    assert.match(out, /does not send anything by itself|sends nothing/);
  });

  test('the disabled state explains that drafts are not lost', () => {
    const out = adminHtml();
    assert.match(out, /will <strong>not<\/strong> process new replies|will not<\/strong> process new replies/);
    assert.match(out, /Drafts\s+already waiting for review/);
  });

  test('both modes are offered and explained', () => {
    const out = adminHtml();
    assert.match(out, /Draft — a person approves every reply/);
    assert.match(out, /Auto — the assistant may send replies itself/);
    // Part B: auto must say the backend guards still apply.
    assert.match(out, /guardrail/i);
  });

  test('only the providers the backend reported are offered', () => {
    const out = adminHtml();
    for (const p of SETTINGS.availableProviders) {
      assert.match(out, new RegExp(`value="${p}"`));
    }
    // Nothing invented.
    for (const p of ['anthropic', 'cohere', 'mistral', 'azure']) {
      assert.ok(!out.includes(`value="${p}"`), `${p} is not a supported provider`);
    }
  });

  test('the model field is free text and says so', () => {
    const out = adminHtml();
    assert.match(out, /free text field/);
    assert.match(out, /gpt-4o-mini/);
  });

  test('the API key shows only its masked state, never a key', () => {
    const out = adminHtml();
    assert.match(out, /API key is configured/);
    assert.match(out, /••••••••wxyz/);
    assert.match(out, /type="password"/);
    // No value attribute can carry a secret: the input is bound to empty state.
    assert.ok(!/sk-/.test(out), 'something key-shaped was rendered');
    assert.match(out, /never shown or sent back/);
  });

  test('the key input is never prefilled', () => {
    const out = adminHtml();
    const keyInput = (out.match(/<input[^>]*type="password"[^>]*>/) || [''])[0];
    assert.ok(keyInput, 'no password input found');
    assert.ok(!/value="[^"]+"/.test(keyInput), `the key input was prefilled: ${keyInput}`);
  });

  test('a missing server encryption key is explained', () => {
    const out = asUser(
      'admin',
      h(AiSettingsForm, {
        settings: { ...SETTINGS, encryptionConfigured: false },
        onSettings() {},
        loading: false,
      })
    );
    assert.match(out, /AI_ENCRYPTION_KEY/);
    assert.match(out, /cannot be stored securely/);
    assert.match(out, /disabled=""/);
  });

  test('persona, business rules and FAQ are all editable text areas', () => {
    const out = adminHtml();
    assert.match(out, /Persona/);
    assert.match(out, /Business rules/);
    assert.match(out, /Reference information \/ FAQ/);
    const textareas = out.match(/<textarea/g) || [];
    assert.ok(textareas.length >= 3, `expected at least 3 textareas, found ${textareas.length}`);
    // The FAQ is free text on the server, and the UI says so rather than
    // inventing a structure the backend does not store.
    assert.match(out, /Stored as free text/);
  });

  test('escalation keywords are listed with a remove control each', () => {
    const out = adminHtml();
    assert.match(out, />human</);
    assert.match(out, />lawyer</);
    assert.match(out, /aria-label="Remove keyword human"/);
    assert.match(out, /aria-label="Remove keyword lawyer"/);
  });

  test('all four limits are rendered as bounded number inputs', () => {
    const out = adminHtml();
    assert.match(out, /Confidence threshold/);
    assert.match(out, /Max AI replies per conversation/);
    assert.match(out, /Messages of context/);
    assert.match(out, /Max reply length/);
    // The server's own bounds, so a bad value is caught before a round trip.
    assert.match(out, /min="0"[^>]*max="1"/);
    assert.match(out, /max="100"/);
    assert.match(out, /max="50"/);
    assert.match(out, /max="1600"/);
  });

  test('the reply limit explains that releasing a takeover does not reset it', () => {
    assert.match(adminHtml(), /does not reset/);
  });

  test('every form control has a label', () => {
    const out = adminHtml();
    // This form labels by wrapping, so every input must sit inside a <label>.
    const stray = out.replace(/<label[\s\S]*?<\/label>/g, '');
    assert.ok(!/<input/.test(stray), 'an input is not inside a label');
    assert.ok(!/<textarea/.test(stray), 'a textarea is not inside a label');
    assert.ok(!/<select/.test(stray), 'a select is not inside a label');
  });

  test('Save is disabled until something changes', () => {
    const out = adminHtml();
    const save = (out.match(/<button[^>]*type="submit"[^>]*>/) || [''])[0];
    assert.match(save, /disabled=""/, 'Save should start disabled — nothing is dirty yet');
  });
});

describe('AiSettingsForm — a non-admin operator', () => {
  const operatorHtml = () =>
    asUser('user', h(AiSettingsForm, { settings: SETTINGS, onSettings() {}, loading: false }));

  test('can see the configuration', () => {
    assert.match(operatorHtml(), /Be brief and warm\./);
  });

  test('gets disabled inputs instead of editable ones', () => {
    const out = operatorHtml();
    const inputs = out.match(/<(input|textarea|select)[^>]*>/g) || [];
    assert.ok(inputs.length > 5);
    for (const control of inputs) {
      assert.match(control, /disabled=""/, `an editable control for a non-admin: ${control}`);
    }
  });

  test('gets no Save button and no activation control', () => {
    const out = operatorHtml();
    assert.ok(!/Save changes/.test(out), 'a non-admin was offered Save');
    assert.ok(!/Remove stored key/.test(out));
    assert.match(out, /Turn AI (on|off)/);
    // The activation button is present but disabled, and says why.
    assert.match(out, /Administrators only/);
  });

  test('is told the server enforces this regardless of the UI', () => {
    assert.match(operatorHtml(), /server enforces that/);
  });

  test('no keyword remove controls are offered', () => {
    assert.ok(!/aria-label="Remove keyword/.test(operatorHtml()));
  });
});

// ===========================================================================
describe('AiConversationPanel', () => {
  test('renders nothing without a conversation', () => {
    const out = render(h(AiConversationPanel, { conversationId: null, aiSettings: SETTINGS }));
    assert.equal(out, '');
  });

  test('shows a loading state before the AI state arrives', () => {
    const out = render(h(AiConversationPanel, { conversationId: 'k1', aiSettings: SETTINGS }));
    assert.match(out, /AI assistant/);
    assert.match(out, /Loading AI state/);
  });
});

// ===========================================================================
describe('AiAssistant page', () => {
  const html = () => inRouter(h(AiAssistant));

  test('renders its heading and both tabs', () => {
    const out = html();
    assert.match(out, /AI assistant/);
    assert.match(out, /role="tablist"/);
    assert.match(out, />Drafts</);
    assert.match(out, />Configuration</);
  });

  test('tabs are real buttons with aria-selected', () => {
    const out = html();
    assert.match(out, /role="tab"[^>]*aria-selected="true"/);
  });

  test('opens on the drafts queue and shows a loading state', () => {
    assert.match(html(), /Loading AI drafts/);
  });
});

// ===========================================================================
// Fix 2 — the one setting that governs what happens when a person answers a
// thread the assistant is working on.
describe('AiSettingsForm — pause AI when a human replies (Fix 2)', () => {
  const withSetting = (value, role = 'admin') =>
    asUser(
      role,
      h(AiSettingsForm, {
        settings: { ...SETTINGS, autoTakeoverOnManualReply: value },
        onSettings() {},
        loading: false,
      })
    );

  test('the checkbox is rendered with its label', () => {
    const out = withSetting(true);
    assert.match(out, /Pause AI in a chat when a human replies/);
  });

  test('it reflects the stored value', () => {
    assert.match(withSetting(true), /name="defaultMode"[\s\S]*?type="checkbox"[^>]*checked=""/);
    const off = withSetting(false);
    const box = (off.match(/<input type="checkbox"[^>]*>/) || [''])[0];
    assert.ok(!/checked/.test(box), 'the checkbox showed as on while the setting was off');
  });

  test('an ABSENT setting renders as on, matching how the server reads it', () => {
    const out = asUser(
      'admin',
      h(AiSettingsForm, { settings: { ...SETTINGS }, onSettings() {}, loading: false })
    );
    const box = (out.match(/<input type="checkbox"[^>]*>/) || [''])[0];
    assert.match(box, /checked=""/);
  });

  test('it explains that cancellation happens either way', () => {
    const out = withSetting(true);
    assert.match(out, /cancelled/);
    assert.match(out, /not optional/);
  });

  test('a non-admin gets it disabled', () => {
    const out = withSetting(true, 'user');
    const box = (out.match(/<input type="checkbox"[^>]*>/) || [''])[0];
    assert.match(box, /disabled=""/);
  });

  test('it sits inside a label, like every other control', () => {
    const out = withSetting(true);
    const stray = out.replace(/<label[\s\S]*?<\/label>/g, '');
    assert.ok(!/type="checkbox"/.test(stray), 'the checkbox is not inside a label');
  });

  test('the form is not dirty just because the setting was read back', () => {
    const out = withSetting(true);
    const save = (out.match(/<button[^>]*type="submit"[^>]*>/) || [''])[0];
    assert.match(save, /disabled=""/, 'the form read as dirty on first render');
  });
});

// AI reply orchestration (Phase 8).
//
// The one place that knows the whole sequence:
//
//   guard -> build prompt -> call provider -> parse -> guard again -> send or draft
//
// Everything it needs is borrowed: compliance from sendPolicy (via guardrails),
// sending from twilioService, carrier opt-out from utils/optOut, logging from
// logService. There is no second Twilio implementation and no second opt-out
// system here.
'use strict';

const Settings = require('../../models/Settings');
const SMSMessage = require('../../models/SMSMessage');
const Conversation = require('../../models/Conversation');
const Contact = require('../../models/Contact');
const AIReplyJob = require('../../models/AIReplyJob');
const twilioService = require('../twilioService');
const { logEvent } = require('../logService');
const { handleCarrierOptOut } = require('../../utils/optOut');
const { config } = require('../../config/env');
const secretBox = require('../../utils/secretBox');

const providers = require('./providers');
const { ProviderError } = require('./providers/errors');
const promptBuilder = require('./promptBuilder');
const { parseProviderResponse, ABSOLUTE_MAX_REPLY } = require('./responseParser');
const guardrails = require('./guardrails');

// Settings.ai.apiKeyEncrypted is `select: false`, so it must be asked for by
// name. This is the ONLY place the plaintext key exists, and it never leaves
// this function's callers as anything but an argument to an adapter.
async function loadAiSettings({ withKey = false } = {}) {
  const query = Settings.findOne({ key: 'twilio' });
  if (withKey) query.select('+ai.apiKeyEncrypted');
  const settings = await query;
  return settings;
}

// Generate a candidate reply. Does NOT send, does NOT touch the database, and
// does NOT consult the guardrails — the caller decides what to do with it.
// Shared by the worker and by the "test a reply" endpoint, which is what keeps
// the tested path and the live path identical.
async function generateReply({ settings, inboundBody, messages = [] }) {
  const ai = (settings && settings.ai) || {};
  const providerName = ai.provider;
  const adapter = providers.getAdapter(providerName);

  const encrypted = ai.apiKeyEncrypted;
  if (!encrypted) {
    throw new ProviderError(`No API key is configured for ${providerName}`, {
      kind: 'auth',
      provider: providerName,
    });
  }

  let apiKey;
  try {
    apiKey = secretBox.decrypt(encrypted);
  } catch (err) {
    // A key that cannot be decrypted is a configuration problem, not a blip —
    // classified as auth so the retry policy stops immediately.
    throw new ProviderError('Stored API key could not be decrypted', {
      kind: 'auth',
      provider: providerName,
    });
  }

  const { system, user } = promptBuilder.buildPrompt({
    inboundBody,
    messages,
    aiSettings: ai,
  });

  const raw = await adapter.generate({
    apiKey,
    model: ai.model,
    system,
    user,
    timeoutMs: config.ai.requestTimeoutMs,
  });

  const parsed = parseProviderResponse(raw, { maxReplyCharacters: ai.maxReplyCharacters });
  return { raw: { provider: raw.provider, model: raw.model, usage: raw.usage }, parsed };
}

// ---------------------------------------------------------------------------
// Fix 2 — at most one answer per customer message.
//
// An AIReplyJob answers ONE specific inbound message. Between the moment it is
// created and the moment it would send, the conversation can move on: an
// operator can answer by hand, a campaign step can go out, or the customer can
// send another message. In every one of those cases the reply this job is
// holding has become the wrong thing to send.
//
// This is the single question that decides it: has anything happened on this
// thread SINCE the message being answered?
//
//   newer OUTBOUND -> the thread already has an answer. Sending would make two.
//   newer INBOUND  -> the customer has moved on; the newer message is the one
//                     that deserves a reply, and a separate job exists for it.
//
// Returns a stable reason token, or null when the job is still current.
//
// Deliberately a QUERY RATHER THAN A FLAG: a flag has to be set correctly by
// every path that could ever write a message, and a path that forgets reopens
// the bug silently. Asking the messages themselves is correct by construction —
// any new message on the thread, from any source, makes a pending reply stale.
async function staleReason(job, inbound) {
  // Without the inbound message there is nothing to answer, and no timestamp to
  // compare against — so there is no way to establish that sending is safe.
  if (!inbound || !inbound.createdAt) return guardrails.REASONS.INBOUND_MISSING;
  if (!job || !job.conversation) return null;

  const newer = await SMSMessage.find({
    conversation: job.conversation,
    createdAt: { $gt: inbound.createdAt },
    deletedAt: null,
  })
    .sort({ createdAt: 1 })
    .select('direction createdAt')
    .limit(50);

  if (!newer || newer.length === 0) return null;

  // Outbound is reported first: "the customer already has an answer" is the more
  // serious finding, and it is true whichever order the two arrived in.
  if (newer.some((m) => m.direction === 'outbound')) {
    return guardrails.REASONS.ALREADY_ANSWERED;
  }
  if (newer.some((m) => m.direction === 'inbound')) {
    return guardrails.REASONS.SUPERSEDED;
  }
  return null;
}

// Stand the assistant down for a thread an operator has just answered by hand.
//
// Called ONLY after a manual reply has actually been sent and recorded — a
// failed send must not cancel the assistant's work or take the thread over.
//
// Two separate things, and the setting governs only the second:
//
//   1. CANCEL queued and drafted work for this conversation. Not configurable:
//      a queued reply to a message a human has now answered is the double-reply
//      bug, not a preference. A job already in `processing` is deliberately left
//      alone — it is mid-flight, and the pre-send staleness check stops it.
//   2. TAKE THE THREAD OVER, if autoTakeoverOnManualReply is not switched off.
//
// Never throws: a failure here must not turn a delivered SMS into an error
// response. The worst case is a cancellation that did not happen, and the
// pre-send check still prevents the second reply.
async function standDownForManualReply({ conversation, contact, user, settings }) {
  const summary = { cancelled: 0, takeover: false };
  if (!conversation || !conversation._id) return summary;

  try {
    // Terminal status + released lock, exactly as the worker's own finish() does,
    // so a cancelled job can never be claimed again.
    const result = await AIReplyJob.updateMany(
      { conversation: conversation._id, status: { $in: ['pending', 'drafted'] } },
      {
        $set: {
          status: 'skipped',
          reason: guardrails.REASONS.HUMAN_REPLIED,
          lockedUntil: new Date(0),
          processedAt: new Date(),
        },
      }
    );
    summary.cancelled = (result && (result.modifiedCount ?? result.nModified)) || 0;

    const ai = (settings && settings.ai) || {};
    // Absent means on: a settings document written before this field existed must
    // behave like a new one.
    const shouldTakeOver = ai.autoTakeoverOnManualReply !== false;

    if (shouldTakeOver) {
      // A targeted $set: the thread's AI mode, reply count and escalation state
      // are not this function's business and must survive untouched.
      await Conversation.updateOne(
        { _id: conversation._id },
        {
          $set: {
            'ai.takeover': true,
            'ai.takeoverAt': new Date(),
            'ai.takeoverBy': user && user._id,
          },
        }
      );
      summary.takeover = true;
    }

    if (summary.cancelled > 0 || summary.takeover) {
      const operator = (user && (user.name || user.email)) || 'An operator';
      await logEvent({
        eventType: 'ai.takeover.auto',
        severity: 'info',
        message: `Manual reply by ${operator} — AI stood down`,
        status: 'takeover',
        contact: contact && contact._id,
        conversation: conversation._id,
        meta: {
          cancelledJobs: summary.cancelled,
          takeover: summary.takeover,
          by: user && user._id ? String(user._id) : undefined,
        },
      });
    }
  } catch (err) {
    // Logged, not thrown. The operator's message was sent; that is what matters.
    console.error('AI stand-down after a manual reply failed:', err.message);
  }

  return summary;
}

// Mark a thread as needing a human, and record why.
async function escalateConversation(conversationId, reason) {
  if (!conversationId) return;
  await Conversation.updateOne(
    { _id: conversationId },
    {
      $set: {
        'ai.escalated': true,
        'ai.escalatedAt': new Date(),
        'ai.escalationReason': String(reason || '').slice(0, 200),
      },
    }
  );
}

// Send a generated reply through the SAME path every other outbound message
// uses: the single Twilio wrapper (which honours SMS_SIMULATE), an SMSMessage
// record, and the shared carrier-opt-out handling for a 21610.
async function sendGeneratedReply({ settings, contact, conversation, reply, job }) {
  const from = settings.defaultFrom || undefined;
  try {
    const result = await twilioService.sendSms({ to: contact.phone, body: reply, from });

    const record = await SMSMessage.create({
      direction: 'outbound',
      to: contact.phone,
      from: result.from || '',
      body: reply,
      twilioSid: result.sid,
      status: result.status,
      contact: contact._id,
      conversation: conversation ? conversation._id : undefined,
      source: 'ai',
      // Fix 3: the link crash recovery reads to decide whether this job has
      // already produced a message. Written in the SAME create as the message
      // itself, so a message can never exist without its job reference.
      aiJob: job ? job._id : undefined,
    });

    if (conversation) {
      await Conversation.updateOne(
        { _id: conversation._id },
        {
          $set: {
            lastMessageAt: new Date(),
            lastMessagePreview: reply.slice(0, 140),
            lastMessageDirection: 'outbound',
          },
        }
      );
    }

    return { sent: true, message: record, result };
  } catch (sendErr) {
    // Twilio 21610 means the carrier says this recipient unsubscribed. Route it
    // through the existing opt-out path so an AI send cannot leave withdrawn
    // consent unrecorded — identical to the manual, retry and reply paths.
    await handleCarrierOptOut(contact, sendErr, {
      path: 'ai',
      conversation: conversation ? conversation._id : undefined,
    });
    return { sent: false, error: sendErr };
  }
}

// Process one job end to end. Returns a description of the outcome; the worker
// owns persistence of status and retry state.
//
//   { outcome: 'sent'|'drafted'|'skipped'|'escalated', reason, parsed?, ... }
// or throws a ProviderError, which the worker classifies for retry.
async function processJob(job, { now = new Date() } = {}) {
  const settings = await loadAiSettings({ withKey: true });
  if (!settings) {
    return { outcome: 'skipped', reason: guardrails.REASONS.AI_DISABLED };
  }

  const [contact, conversation, inbound] = await Promise.all([
    Contact.findById(job.contact),
    Conversation.findById(job.conversation),
    SMSMessage.findById(job.inboundMessage),
  ]);

  const inboundBody = inbound ? inbound.body : '';

  // --- Fix 2, check 1 of 2: is this job still current? ---
  // Before the guardrails and before any provider call, because generating a
  // reply nobody should receive costs money and achieves nothing.
  const staleBefore = await staleReason(job, inbound);
  if (staleBefore) {
    return { outcome: 'skipped', reason: staleBefore };
  }

  // --- gate 1: may we generate at all? ---
  const canGenerate = await guardrails.checkCanGenerate({
    settings,
    contact,
    conversation,
    inboundBody,
  });
  if (!canGenerate.allowed) {
    if (canGenerate.escalate) {
      await escalateConversation(job.conversation, canGenerate.reason);
      return { outcome: 'escalated', reason: canGenerate.reason, detail: canGenerate.detail };
    }
    return { outcome: 'skipped', reason: canGenerate.reason, detail: canGenerate.detail };
  }

  // --- generate ---
  // Newest-first, bounded; the prompt builder reverses to chronological order.
  const history = await SMSMessage.find({ contact: job.contact, deletedAt: null })
    .sort({ createdAt: -1 })
    .limit(Math.max(1, (settings.ai && settings.ai.contextMessageLimit) || 10))
    .select('direction body createdAt');

  const { raw, parsed } = await generateReply({
    settings,
    inboundBody,
    messages: history,
  });

  if (!parsed.ok) {
    // Invalid model output is never sent. Treated as a failure so the bounded
    // retry policy applies — a one-off malformed response may well succeed next
    // time, and the attempt ceiling stops it looping.
    const err = new ProviderError(`Unusable model output: ${parsed.reason}`, {
      kind: 'temporary',
      provider: raw.provider,
    });
    err.parseFailure = parsed.reason;
    throw err;
  }

  const result = {
    parsed,
    provider: raw.provider,
    model: raw.model,
    usage: raw.usage,
  };

  // --- gate 2: may this reply be sent? ---
  if (job.mode !== 'auto') {
    return { ...result, outcome: 'drafted', reason: 'draft_mode' };
  }

  const canSend = await guardrails.checkCanSendReply({
    settings,
    contact,
    conversation,
    parsed,
    mode: job.mode,
    now,
  });

  if (!canSend.allowed) {
    if (canSend.escalate) {
      await escalateConversation(job.conversation, canSend.reason);
      return { ...result, outcome: 'escalated', reason: canSend.reason, detail: canSend.detail };
    }
    if (canSend.temporary) {
      // Quiet hours or an unverifiable line type: the reply is good, the moment
      // is not. Surfaced to the worker as retryable.
      return { ...result, outcome: 'retry', reason: canSend.reason, detail: canSend.detail };
    }
    // A definitive block still produces a usable draft for a human.
    return { ...result, outcome: 'drafted', reason: canSend.reason, detail: canSend.detail };
  }

  // --- Fix 2, check 2 of 2: THE ONE THAT MATTERS ---
  //
  // Re-read the thread immediately before sending. Generating a reply takes
  // seconds — a network round trip to a model — and the first check was made
  // before that. In the gap an operator can answer by hand, the customer can
  // send another message, or a campaign step can go out.
  //
  // This is the last point at which a second reply can still be prevented, and
  // it sits directly above the send with nothing awaited in between.
  const staleNow = await staleReason(job, inbound);
  if (staleNow) {
    // The generated text is returned with the outcome, so the worker still
    // records what the model produced. Nothing is sent.
    return { ...result, outcome: 'skipped', reason: staleNow };
  }

  const sendResult = await sendGeneratedReply({
    settings,
    contact,
    conversation,
    reply: parsed.reply,
    job,
  });

  if (!sendResult.sent) {
    const err = new ProviderError(
      `Sending the AI reply failed: ${sendResult.error && sendResult.error.message}`,
      { kind: sendResult.error && sendResult.error.permanent ? 'permanent' : 'temporary' }
    );
    throw err;
  }

  return { ...result, outcome: 'sent', reason: '', sentMessage: sendResult.message };
}

// Enqueue AI work for an inbound message. Called from the webhook AFTER the
// message is safely persisted.
//
// Safe by construction: returns null rather than throwing, so nothing here can
// break webhook acknowledgement; and the unique index on `inboundMessage` means
// a duplicate webhook or a race can only ever produce one job.
async function enqueueForInboundMessage({ contact, conversation, inboundMessage, settings }) {
  try {
    if (!contact || !conversation || !inboundMessage) return null;

    const resolved = settings || (await loadAiSettings());
    if (!resolved || !resolved.ai || !resolved.ai.enabled) return null;
    if (conversation.ai && conversation.ai.takeover) return null;

    const mode = guardrails.resolveMode(resolved, conversation);

    return await AIReplyJob.create({
      conversation: conversation._id,
      contact: contact._id,
      inboundMessage: inboundMessage._id,
      mode,
      status: 'pending',
      nextAttemptAt: new Date(),
    });
  } catch (err) {
    // E11000 means a job already exists for this message, which is the desired
    // end state, not a problem.
    if (err && err.code === 11000) return null;
    await logEvent({
      eventType: 'ai.provider.error',
      severity: 'error',
      message: 'Could not enqueue an AI reply job',
      status: 'enqueue_failed',
      contact: contact && contact._id,
      conversation: conversation && conversation._id,
      error: String(err.message || 'enqueue failed').slice(0, 200),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase 8.1 — human review of a stored draft.
//
// Two operations, approve and reject. Neither ever calls a provider: the text
// already exists, so `loadAiSettings()` is called WITHOUT the key — on this path
// the stored credential is not even decrypted.
//
// Both are driven entirely from the job id. NOTHING about the recipient, the
// thread, the provider or the approving identity is taken from the request; all
// of it is re-read from the database here. The only client input that reaches
// this code is the job id and an optional replacement body.
// ---------------------------------------------------------------------------

// How long an approval may hold a claim. Short, because unlike generation there
// is no model round trip to wait for — only a Twilio call.
const APPROVAL_CLAIM_TTL_MS = 2 * 60 * 1000;

// Blocks that can never clear by waiting. Consent has been withdrawn, or the
// people involved no longer exist, so the draft is retired instead of being left
// approvable forever. Everything else (smsEnabled off, a takeover, quiet hours,
// a line type that cannot be verified) is a condition an admin or the clock can
// change, so the draft is handed back intact.
const PERMANENT_BLOCK_REASONS = new Set([
  guardrails.REASONS.OPTED_OUT,
  guardrails.REASONS.INACTIVE,
  guardrails.REASONS.DELIVERY_BLOCKED,
  guardrails.REASONS.NO_CONTACT,
  guardrails.REASONS.NO_CONVERSATION,
]);

// Validate an operator's replacement text against the SAME length policy the
// generated reply had to satisfy.
//
// Trim only: the text is stored and sent exactly as the operator wrote it,
// newlines included. Over-length is REFUSED, never truncated — silently cutting
// someone's message mid-sentence is worse than telling them it is too long.
function validateApprovedBody(raw, settings) {
  if (raw === undefined || raw === null) return { provided: false, ok: true, body: '' };
  if (typeof raw !== 'string') {
    return { provided: true, ok: false, reason: 'body must be a string' };
  }
  const body = raw.trim();
  if (!body) {
    return { provided: true, ok: false, reason: 'body cannot be empty' };
  }
  const ai = (settings && settings.ai) || {};
  const configured = Number(ai.maxReplyCharacters);
  const ceiling = Math.min(
    Number.isFinite(configured) && configured > 0 ? configured : 320,
    ABSOLUTE_MAX_REPLY
  );
  if (body.length > ceiling) {
    return {
      provided: true,
      ok: false,
      reason: `body is ${body.length} characters; the maximum is ${ceiling}`,
    };
  }
  return { provided: true, ok: true, body };
}

// Hand a claimed job back as an approvable draft. Nothing was sent.
async function releaseToDraft(job, { reason = '', lastError = '' } = {}) {
  job.status = 'drafted';
  job.lockedUntil = new Date(0);
  if (reason) job.reason = reason;
  if (lastError) job.lastError = String(lastError).slice(0, 300);
  await job.save();
}

// Retire a claimed job into a terminal state it can never leave.
async function retireJob(job, { status, reason }) {
  job.status = status;
  job.reason = reason;
  job.lockedUntil = new Date(0);
  job.processedAt = new Date();
  await job.save();
}

// Approve a draft and send it, optionally replacing the text first.
//
// IDEMPOTENCY / RACE SAFETY is a single atomic status transition: the claim
// matches `status: 'drafted'` and flips it to 'processing' in one database
// operation. Two simultaneous approvals therefore cannot both proceed — the
// loser matches nothing, observes the job is no longer approvable, and returns
// without sending. There is no application-level lock and nothing for a client
// to bypass.
//
// Returns a plain outcome; the controller maps it to HTTP.
async function approveDraft({ jobId, body, approvedBy, now = new Date() }) {
  // No key: an approval must never be able to reach a provider.
  const settings = await loadAiSettings();
  if (!settings) return { outcome: 'no_settings' };

  // Validated BEFORE the claim, so a rejected edit leaves the draft untouched
  // and still approvable rather than stranded mid-transition.
  const edit = validateApprovedBody(body, settings);
  if (!edit.ok) return { outcome: 'invalid_body', reason: edit.reason };

  const job = await AIReplyJob.findOneAndUpdate(
    { _id: jobId, status: 'drafted', lockedUntil: { $not: { $gte: now } } },
    { $set: { status: 'processing', lockedUntil: new Date(now.getTime() + APPROVAL_CLAIM_TTL_MS) } },
    { new: true }
  );

  if (!job) {
    // Either it does not exist, or it is not a draft any more: already sent,
    // already rejected, still pending, escalated, or being approved right now by
    // another request.
    const existing = await AIReplyJob.findById(jobId);
    if (!existing) return { outcome: 'not_found' };
    return { outcome: 'not_approvable', status: existing.status, job: existing };
  }

  // Fix 3: FROM HERE THE JOB IS CLAIMED.
  //
  // Every exit below has to release it. The ordinary refusals already do, but an
  // UNEXPECTED failure — a database blip, a bug — would otherwise leave the job
  // in `processing` with the draft unreachable until the recovery pass noticed
  // it, minutes later. The work is therefore done in its own function and the
  // claim released here whatever happens, before the error is re-thrown for the
  // controller to report.
  try {
    return await sendApprovedDraft({ job, edit, settings, approvedBy, now });
  } catch (err) {
    try {
      await releaseToDraft(job, {
        reason: 'approval_error',
        lastError: (err && err.message) || 'approval failed',
      });
    } catch (releaseError) {
      // The recovery pass is the backstop if even this fails.
      console.error('Releasing an approval claim failed:', releaseError.message);
    }
    throw err;
  }
}

// The approval work itself: a CLAIMED job in, a sent message out. Split from
// approveDraft only so that the claim release above can be guaranteed; the
// sequence is unchanged.
async function sendApprovedDraft({ job, edit, settings, approvedBy, now }) {
  const generated = String(job.draftReply || '').trim();
  const finalBody = edit.provided ? edit.body : generated;
  if (!finalBody) {
    await releaseToDraft(job, { reason: 'empty_draft' });
    return { outcome: 'empty_draft' };
  }

  // Everything that governs the send is re-read from the database here.
  // The inbound message comes along for the staleness check below.
  const [contact, conversation, inbound] = await Promise.all([
    Contact.findById(job.contact),
    Conversation.findById(job.conversation),
    SMSMessage.findById(job.inboundMessage),
  ]);

  if (!contact) {
    await retireJob(job, { status: 'skipped', reason: guardrails.REASONS.NO_CONTACT });
    return { outcome: 'blocked', reason: guardrails.REASONS.NO_CONTACT, permanent: true };
  }
  // A soft-deleted thread counts as gone: an admin removed it, so nothing should
  // be sent into it.
  if (!conversation || conversation.deletedAt) {
    await retireJob(job, { status: 'skipped', reason: guardrails.REASONS.NO_CONVERSATION });
    return { outcome: 'blocked', reason: guardrails.REASONS.NO_CONVERSATION, permanent: true };
  }

  // Every compliance rule, evaluated at the moment of sending — not at the
  // moment the draft was generated. A STOP that arrived in between blocks here.
  const verdict = await guardrails.checkCanSendApproved({ settings, contact, conversation, now });
  if (!verdict.allowed) {
    const permanent = PERMANENT_BLOCK_REASONS.has(verdict.reason);
    if (permanent) {
      await retireJob(job, { status: 'skipped', reason: verdict.reason });
    } else {
      await releaseToDraft(job, { reason: verdict.reason });
    }
    return {
      outcome: 'blocked',
      reason: verdict.reason,
      detail: verdict.detail,
      temporary: !!verdict.temporary,
      permanent,
      contact,
      conversation,
    };
  }

  // --- Fix 2: has the thread moved on since this draft was written? ---
  //
  // A draft can sit in the queue for hours. In that time an operator may have
  // answered by hand, or the customer may have sent something else — and then
  // approving it sends a reply to a question that has already been dealt with.
  //
  // The draft is handed back intact rather than retired: the operator may still
  // want to read it, and discarding it is their decision, not this function's.
  const stale = await staleReason(job, inbound);
  if (stale) {
    await releaseToDraft(job, { reason: stale });
    return { outcome: 'stale', reason: stale, contact, conversation };
  }

  // --- Fix 3: has this job ALREADY produced a message? ---
  //
  // The case: an approval sent successfully, then the process died before the
  // job could be marked sent. Recovery hands it back as a draft, and the
  // operator — seeing it still waiting — approves it again. Without this the
  // customer gets the same reply twice.
  //
  // Asked through the direct aiJob link, so the answer is exact rather than
  // inferred. The job is finished as sent against the message that already
  // exists; nothing new is sent.
  const alreadySent = await SMSMessage.findOne({ aiJob: job._id });
  if (alreadySent) {
    job.status = 'sent';
    job.reason = 'recovered_sent';
    job.sentMessage = alreadySent._id;
    job.lockedUntil = new Date(0);
    job.processedAt = new Date();
    await job.save();
    return { outcome: 'already_sent', job, message: alreadySent, contact, conversation };
  }

  // The SAME send path every other outbound message uses: one Twilio wrapper
  // (so SMS_SIMULATE applies), one SMSMessage record stamped `source: 'ai'`, the
  // thread's activity updated, and a 21610 routed through the platform's single
  // carrier-opt-out handler. No second implementation of any of it.
  const sendResult = await sendGeneratedReply({
    settings,
    contact,
    conversation,
    reply: finalBody,
    job,
  });

  if (!sendResult.sent) {
    const message = (sendResult.error && sendResult.error.message) || 'send failed';
    // Handed back rather than failed: the operator can try again once whatever
    // went wrong is fixed. If the failure was a 21610, sendGeneratedReply has
    // already opted the contact out, so a retry is blocked by consent.
    await releaseToDraft(job, { reason: 'send_failed', lastError: message });
    return { outcome: 'send_failed', error: sendResult.error, contact, conversation };
  }

  job.status = 'sent';
  job.approvedBy = approvedBy;
  job.approvedAt = new Date();
  // draftReply is left exactly as the model produced it; the edit lives beside it.
  job.approvedBody = edit.provided ? finalBody : '';
  job.edited = !!edit.provided;
  job.sentMessage = sendResult.message && sendResult.message._id;
  job.reason = edit.provided ? 'approved_edited' : 'approved';
  job.lastError = '';
  job.lockedUntil = new Date(0);
  job.processedAt = new Date();
  await job.save();

  // NOTE: Conversation.ai.replyCount is deliberately NOT incremented. The worker
  // already counted this reply when it recorded the draft; counting it again on
  // approval would charge one assistant turn twice against the per-conversation
  // limit.

  return {
    outcome: 'sent',
    job,
    message: sendResult.message,
    result: sendResult.result,
    edited: !!edit.provided,
    bodyLength: finalBody.length,
    contact,
    conversation,
  };
}

// Discard a draft. No SMS, no provider call, and the job is never deleted —
// a declined draft is evidence of a decision.
//
// Idempotent by the same mechanism as approval: one atomic transition out of
// 'drafted'. Rejecting an already-rejected job reports success without writing
// again, and because approval only ever claims a 'drafted' job, a rejected draft
// can never afterwards be approved.
//
// Only a 'drafted' job may be rejected. A 'pending' one is the worker's to pick
// up and could be claimed mid-rejection, so it is left alone.
async function rejectDraft({ jobId, rejectedBy, now = new Date() }) {
  const job = await AIReplyJob.findOneAndUpdate(
    { _id: jobId, status: 'drafted' },
    {
      $set: {
        status: 'rejected',
        rejectedBy,
        rejectedAt: now,
        reason: 'rejected',
        lockedUntil: new Date(0),
        processedAt: now,
      },
    },
    { new: true }
  );
  if (job) return { outcome: 'rejected', job, already: false };

  const existing = await AIReplyJob.findById(jobId);
  if (!existing) return { outcome: 'not_found' };
  if (existing.status === 'rejected') {
    return { outcome: 'rejected', job: existing, already: true };
  }
  return { outcome: 'not_rejectable', status: existing.status, job: existing };
}

module.exports = {
  loadAiSettings,
  generateReply,
  processJob,
  enqueueForInboundMessage,
  sendGeneratedReply,
  escalateConversation,
  approveDraft,
  rejectDraft,
  validateApprovedBody,
  APPROVAL_CLAIM_TTL_MS,
  // Fix 2.
  staleReason,
  standDownForManualReply,
};

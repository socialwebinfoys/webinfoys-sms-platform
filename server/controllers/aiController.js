// AI configuration and state API (Phase 8).
//
// Backend only — Phase 9 builds the screens. The contract here is what those
// screens will consume.
//
// THE RULE THAT GOVERNS THIS FILE: a provider API key goes IN and is never seen
// again. It is encrypted on the way in, stored `select: false`, and every read
// path returns only { configured, masked }. There is no endpoint, anywhere, that
// returns a decrypted key.
'use strict';

const Settings = require('../models/Settings');
const Conversation = require('../models/Conversation');
const AIReplyJob = require('../models/AIReplyJob');
const secretBox = require('../utils/secretBox');
const providers = require('../services/ai/providers');
const aiService = require('../services/ai/aiService');
const { logEvent } = require('../services/logService');
const { queryString } = require('../utils/queryGuards');

const MAX_LIMIT = 100;

// The safe projection of AI settings. Everything an operator may see; nothing
// they may not. Note apiKeyEncrypted is never spread into this.
function presentAiSettings(settings) {
  const ai = (settings && settings.ai) || {};
  return {
    enabled: !!ai.enabled,
    defaultMode: ai.defaultMode || 'draft',
    provider: ai.provider || '',
    model: ai.model || '',
    availableProviders: providers.PROVIDER_NAMES,
    defaultModelForProvider: ai.provider && providers.isSupported(ai.provider)
      ? providers.defaultModelFor(ai.provider)
      : '',
    persona: ai.persona || '',
    businessRules: ai.businessRules || '',
    faq: ai.faq || '',
    escalationKeywords: ai.escalationKeywords || [],
    confidenceThreshold: ai.confidenceThreshold,
    maxRepliesPerConversation: ai.maxRepliesPerConversation,
    contextMessageLimit: ai.contextMessageLimit,
    maxReplyCharacters: ai.maxReplyCharacters,
    // Fix 2. Absent on a settings document written before this field existed, so
    // it is read the same way the guard does: anything but an explicit false is
    // on. That keeps an old document and a new one behaving identically.
    autoTakeoverOnManualReply: ai.autoTakeoverOnManualReply !== false,
    // Masked only. Shape: { configured: boolean, masked: '••••••••abcd' }.
    apiKey: secretBox.describe(ai.apiKeyEncrypted),
    // So the UI can explain why saving a key is refused, without exposing it.
    encryptionConfigured: secretBox.isConfigured(),
  };
}

// GET /api/ai/settings   (any authenticated operator)
async function getAiSettings(req, res, next) {
  try {
    const settings = await Settings.findOne({ key: 'twilio' }).select('+ai.apiKeyEncrypted');
    return res.json({ success: true, settings: presentAiSettings(settings) });
  } catch (err) {
    return next(err);
  }
}

// PUT /api/ai/settings   (admin only)
//
// Partial update: only fields actually present in the body are touched, so a
// screen that edits one thing cannot blank the rest.
async function updateAiSettings(req, res, next) {
  try {
    const settings = await Settings.getSingleton();
    const body = req.body || {};
    const changes = [];

    if (body.enabled !== undefined) {
      settings.ai.enabled = !!body.enabled;
      changes.push(`enabled=${settings.ai.enabled}`);
    }

    // Fix 2. Same shape as `enabled` above: a plain boolean, coerced, logged by
    // name and never by value.
    if (body.autoTakeoverOnManualReply !== undefined) {
      settings.ai.autoTakeoverOnManualReply = !!body.autoTakeoverOnManualReply;
      changes.push(`autoTakeoverOnManualReply=${settings.ai.autoTakeoverOnManualReply}`);
    }

    if (body.defaultMode !== undefined) {
      if (!['draft', 'auto'].includes(body.defaultMode)) {
        return res.status(400).json({ success: false, message: "defaultMode must be 'draft' or 'auto'" });
      }
      settings.ai.defaultMode = body.defaultMode;
      changes.push(`defaultMode=${body.defaultMode}`);
    }

    if (body.provider !== undefined) {
      if (!providers.isSupported(body.provider)) {
        return res.status(400).json({
          success: false,
          message: `provider must be one of: ${providers.PROVIDER_NAMES.join(', ')}`,
        });
      }
      settings.ai.provider = body.provider;
      changes.push(`provider=${body.provider}`);
    }

    if (body.model !== undefined) {
      settings.ai.model = String(body.model).trim();
      changes.push('model');
    }

    // The key is write-only. Sending '' clears it; omitting it leaves it alone.
    if (body.apiKey !== undefined) {
      const key = String(body.apiKey).trim();
      if (!key) {
        settings.ai.apiKeyEncrypted = '';
        changes.push('apiKey cleared');
      } else {
        if (!secretBox.isConfigured()) {
          return res.status(503).json({
            success: false,
            message:
              'AI_ENCRYPTION_KEY is not configured on the server, so an API key cannot be stored securely.',
          });
        }
        settings.ai.apiKeyEncrypted = secretBox.encrypt(key);
        changes.push('apiKey set');
      }
    }

    for (const field of ['persona', 'businessRules', 'faq']) {
      if (body[field] !== undefined) {
        settings.ai[field] = String(body[field]);
        changes.push(field);
      }
    }

    if (body.escalationKeywords !== undefined) {
      if (!Array.isArray(body.escalationKeywords)) {
        return res.status(400).json({ success: false, message: 'escalationKeywords must be an array' });
      }
      settings.ai.escalationKeywords = [
        ...new Set(body.escalationKeywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean)),
      ];
      changes.push('escalationKeywords');
    }

    const numericFields = [
      ['confidenceThreshold', 0, 1, false],
      ['maxRepliesPerConversation', 0, 100, true],
      ['contextMessageLimit', 1, 50, true],
      ['maxReplyCharacters', 20, 1600, true],
    ];
    for (const [field, min, max, integer] of numericFields) {
      if (body[field] === undefined) continue;
      const value = Number(body[field]);
      if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
        return res.status(400).json({
          success: false,
          message: `${field} must be ${integer ? 'a whole number' : 'a number'} between ${min} and ${max}`,
        });
      }
      settings.ai[field] = value;
      changes.push(field);
    }

    if (changes.length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    await settings.save();

    // The CHANGE is logged, never the value of a secret.
    await logEvent({
      eventType: 'ai.settings.updated',
      severity: 'warning',
      message: `${req.user.name || req.user.email} updated AI settings: ${changes.join(', ')}`,
      status: 'updated',
      meta: { changes, by: String(req.user._id) },
    });

    const fresh = await Settings.findOne({ key: 'twilio' }).select('+ai.apiKeyEncrypted');
    return res.json({ success: true, settings: presentAiSettings(fresh) });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    return next(err);
  }
}

// POST /api/ai/test   (admin only)
//
// Generates a reply and returns it WITHOUT sending anything and WITHOUT touching
// conversation state. Lets an operator check a persona before enabling AI.
// Phase 10's "Test Reply" UI will sit on top of this.
async function testAiReply(req, res, next) {
  try {
    const message = String((req.body && req.body.message) || '').trim();
    if (!message) {
      return res.status(400).json({ success: false, message: 'A message is required' });
    }

    const settings = await aiService.loadAiSettings({ withKey: true });
    if (!settings || !settings.ai || !settings.ai.provider) {
      return res.status(400).json({ success: false, message: 'No AI provider is configured' });
    }

    try {
      const { raw, parsed } = await aiService.generateReply({
        settings,
        inboundBody: message,
        messages: [],
      });

      if (!parsed.ok) {
        return res.status(422).json({
          success: false,
          message: `The provider returned something unusable (${parsed.reason})`,
          reason: parsed.reason,
        });
      }

      return res.json({
        success: true,
        // Stated plainly: this endpoint can never send.
        sent: false,
        reply: parsed.reply,
        confidence: parsed.confidence,
        shouldEscalate: parsed.shouldEscalate,
        reason: parsed.reason,
        provider: raw.provider,
        model: raw.model,
        usage: raw.usage,
      });
    } catch (providerErr) {
      await logEvent({
        eventType: 'ai.provider.error',
        severity: 'error',
        message: 'AI test generation failed',
        status: 'test_failed',
        error: String(providerErr.message || '').slice(0, 200),
        meta: { kind: providerErr.kind, provider: providerErr.provider, by: String(req.user._id) },
      });
      return res.status(502).json({
        success: false,
        message: providerErr.message || 'The AI provider call failed',
        kind: providerErr.kind,
      });
    }
  } catch (err) {
    return next(err);
  }
}

// GET /api/ai/conversations/:id   (any authenticated operator)
// The AI state of one thread, plus its recent AI jobs/drafts.
async function getConversationAiState(req, res, next) {
  try {
    const convo = await Conversation.findOne({ _id: req.params.id, deletedAt: null });
    if (!convo) {
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), MAX_LIMIT);
    const jobs = await AIReplyJob.find({ conversation: convo._id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('status mode draftReply confidence provider model reason escalated attempts createdAt processedAt');

    const ai = convo.ai || {};
    return res.json({
      success: true,
      conversation: convo._id,
      state: {
        takeover: !!ai.takeover,
        takeoverAt: ai.takeoverAt,
        mode: ai.mode || '',
        replyCount: ai.replyCount || 0,
        lastReplyAt: ai.lastReplyAt,
        escalated: !!ai.escalated,
        escalatedAt: ai.escalatedAt,
        escalationReason: ai.escalationReason || '',
      },
      jobs,
    });
  } catch (err) {
    return next(err);
  }
}

// POST /api/ai/conversations/:id/takeover    (any authenticated operator)
// DELETE /api/ai/conversations/:id/takeover
//
// Taking over is a normal operator action, not an admin one — whoever is working
// the inbox needs to be able to stand the assistant down immediately.
async function setTakeover(req, res, next, active) {
  try {
    const convo = await Conversation.findOne({ _id: req.params.id, deletedAt: null });
    if (!convo) {
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }

    convo.ai = convo.ai || {};
    convo.ai.takeover = active;
    if (active) {
      convo.ai.takeoverAt = new Date();
      convo.ai.takeoverBy = req.user._id;
    } else {
      convo.ai.takeoverAt = undefined;
      convo.ai.takeoverBy = undefined;
      // Releasing also clears a rule-based escalation, so the assistant can
      // resume. A human has looked at the thread; that is what escalation asked
      // for. The reply counter is deliberately NOT reset — the limit is per
      // conversation, and resetting it here would make it bypassable.
      convo.ai.escalated = false;
      convo.ai.escalationReason = '';
    }
    await convo.save();

    const operator = req.user.name || req.user.email;
    await logEvent({
      eventType: active ? 'ai.takeover.enabled' : 'ai.takeover.released',
      severity: 'info',
      message: `${operator} ${active ? 'took over' : 'released'} conversation ${convo._id}`,
      status: active ? 'takeover' : 'released',
      contact: convo.contact,
      conversation: convo._id,
      meta: { by: String(req.user._id) },
    });

    return res.json({
      success: true,
      takeover: convo.ai.takeover,
      escalated: convo.ai.escalated,
    });
  } catch (err) {
    return next(err);
  }
}

const enableTakeover = (req, res, next) => setTakeover(req, res, next, true);
const releaseTakeover = (req, res, next) => setTakeover(req, res, next, false);

// GET /api/ai/jobs?status=&conversation=   (any authenticated operator)
async function listAiJobs(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), MAX_LIMIT);

    const filter = {};
    const status = queryString(req.query.status);
    if (status) {
      if (!AIReplyJob.STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `status must be one of: ${AIReplyJob.STATUSES.join(', ')}`,
        });
      }
      filter.status = status;
    }
    const conversation = queryString(req.query.conversation);
    if (conversation) {
      if (!/^[0-9a-fA-F]{24}$/.test(conversation)) {
        return res.status(400).json({ success: false, message: 'Invalid conversation id' });
      }
      filter.conversation = conversation;
    }

    // Phase 9: the draft queue has to say WHO each draft is for. Without this the
    // only alternative is one request per row, which is the N+1 the frontend is
    // told to avoid; populate costs one extra query per path regardless of page
    // size. Purely additive — existing fields keep their shape, and the same
    // narrow projection getConversation already uses is applied here, so no field
    // that was not already exposed elsewhere becomes visible.
    const [items, total] = await Promise.all([
      AIReplyJob.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('contact', 'name phone optedOut deliveryBlocked isActive')
        .populate('conversation', 'contactName contactPhone status deletedAt'),
      AIReplyJob.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 0 },
    });
  } catch (err) {
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// Phase 8.1 — draft review and per-conversation mode.
// ---------------------------------------------------------------------------

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

// How each guardrail refusal is reported. Chosen to match the inbox reply path,
// which already answers 403 for consent, 422 for a definitive policy block and
// 503 for something that may succeed later.
const BLOCK_STATUS = {
  sms_disabled: 400,
  opted_out: 403,
  inactive: 403,
  delivery_blocked: 403,
  invalid_number: 403,
  // State conflicts: the thread or its people are not in a condition to be
  // messaged, which is not the caller's fault and not a permission problem.
  no_contact: 409,
  no_conversation: 409,
  takeover: 409,
  line_type_blocked: 422,
  // Could succeed later: an unverifiable line type, or the wrong hour.
  line_type_unknown: 503,
  outside_window: 503,
};

// Human-readable text for a refusal. Deliberately written here rather than
// passed through from the guardrails so an internal detail string can never be
// returned to a client verbatim.
const BLOCK_MESSAGE = {
  sms_disabled: 'SMS sending is disabled in settings',
  opted_out: 'This contact has opted out of SMS',
  inactive: 'This contact is marked inactive',
  delivery_blocked: 'Messages to this number keep failing to be delivered',
  invalid_number: 'Twilio Lookup reports this number as invalid',
  no_contact: 'The contact this draft was written for no longer exists',
  no_conversation: 'The conversation this draft belongs to no longer exists',
  takeover: 'A human has taken over this conversation',
  line_type_blocked: "This number's line type is not allowed by the current policy",
  line_type_unknown: 'This number\'s line type cannot be verified right now',
  outside_window: 'Outside the configured sending window for this recipient',
};

// POST /api/ai/jobs/:id/approve   (any authenticated operator)
//
// Optional body: { body: "edited text" }. That, and the job id in the path, are
// the ONLY things taken from the client. The recipient, the thread, the provider,
// the approving identity and every compliance decision are loaded server-side —
// see aiService.approveDraft.
//
// Approving is an operator action, not an admin one, for the same reason takeover
// is: whoever works the inbox has to be able to answer a customer.
async function approveAiDraft(req, res, next) {
  try {
    const jobId = String(req.params.id || '');
    if (!OBJECT_ID.test(jobId)) {
      return res.status(400).json({ success: false, message: 'Invalid job id' });
    }

    const result = await aiService.approveDraft({
      jobId,
      // `undefined` means "send the draft as generated"; a present value is an edit.
      body: req.body && req.body.body !== undefined ? req.body.body : undefined,
      // Taken from the verified token, never from the request body.
      approvedBy: req.user._id,
    });

    const operator = req.user.name || req.user.email;

    switch (result.outcome) {
      case 'not_found':
        return res.status(404).json({ success: false, message: 'AI draft not found' });

      case 'invalid_body':
        return res.status(400).json({ success: false, message: result.reason });

      case 'no_settings':
        return res
          .status(503)
          .json({ success: false, message: 'Platform settings are not initialised' });

      case 'not_approvable':
        // Covers an already-sent draft, an already-rejected one, and the loser of
        // a simultaneous approval. The current status is returned so the UI can
        // refresh instead of guessing.
        return res.status(409).json({
          success: false,
          message: `This draft is no longer awaiting approval (status: ${result.status})`,
          status: result.status,
        });

      case 'empty_draft':
        return res.status(422).json({
          success: false,
          message: 'This draft has no text to send. Supply an edited body instead.',
        });

      // Fix 3: this draft had ALREADY been sent — an earlier approval reached
      // Twilio but died before the job could be marked sent, and recovery handed
      // the job back as a draft. Reported as success, because the operator's
      // intent (this reply reaches the customer) is satisfied, and nothing new
      // was sent.
      case 'already_sent':
        return res.json({
          success: true,
          job: result.job,
          message: result.message,
          alreadySent: true,
          edited: false,
          notice:
            'This reply had already been sent — an earlier approval completed but was not recorded. Nothing was sent again.',
        });

      // Fix 2: the thread was answered, or the customer wrote again, after this
      // draft was written. 409 because it is a state conflict, not a permission
      // problem — and the draft is still there, so `approvable` stays true.
      case 'stale': {
        await logEvent({
          eventType: 'ai.draft.blocked',
          severity: 'warning',
          message: `Approval of an AI draft by ${operator} was blocked: ${result.reason}`,
          status: 'blocked',
          contact: result.contact && result.contact._id,
          conversation: result.conversation && result.conversation._id,
          meta: { jobId, reason: result.reason, stale: true, by: String(req.user._id) },
        });
        return res.status(409).json({
          success: false,
          message:
            result.reason === 'superseded'
              ? 'This customer sent another message after the draft was written. Nothing was sent — read the newer message first.'
              : result.reason === 'inbound_missing'
                ? 'The message this draft was answering is no longer available. Nothing was sent.'
                : 'This chat was answered after the draft was written. Nothing was sent.',
          reason: result.reason,
          // The draft was handed back, so it can still be read or discarded.
          approvable: true,
        });
      }

      case 'blocked': {
        await logEvent({
          eventType: 'ai.draft.blocked',
          severity: 'warning',
          message: `Approval of an AI draft by ${operator} was blocked: ${result.reason}`,
          status: 'blocked',
          contact: result.contact && result.contact._id,
          conversation: result.conversation && result.conversation._id,
          meta: {
            jobId,
            reason: result.reason,
            detail: result.detail,
            permanent: !!result.permanent,
            by: String(req.user._id),
          },
        });
        return res.status(BLOCK_STATUS[result.reason] || 422).json({
          success: false,
          message: BLOCK_MESSAGE[result.reason] || 'This draft cannot be sent',
          reason: result.reason,
          // Whether the draft survives for a later attempt.
          approvable: !result.permanent,
        });
      }

      case 'send_failed': {
        const err = result.error || {};
        await logEvent({
          eventType: 'ai.draft.send_failed',
          severity: 'error',
          message: `Sending an AI draft approved by ${operator} failed`,
          status: 'failed',
          contact: result.contact && result.contact._id,
          conversation: result.conversation && result.conversation._id,
          error: String(err.message || 'send failed').slice(0, 200),
          meta: { jobId, by: String(req.user._id) },
        });
        return res.status(err.statusCode || 502).json({
          success: false,
          message: err.message || 'Failed to send the approved draft',
          // The draft was handed back, so the operator can retry.
          approvable: true,
        });
      }

      case 'sent': {
        // The LENGTH of the message is logged, never its text: the body is a
        // customer communication and already lives in SMSMessage.
        await logEvent({
          eventType: 'ai.draft.approved',
          severity: 'info',
          message: `${operator} approved ${result.edited ? 'an edited ' : 'an '}AI draft`,
          status: 'sent',
          contact: result.contact && result.contact._id,
          conversation: result.conversation && result.conversation._id,
          twilioSid: result.result && result.result.sid,
          meta: {
            jobId,
            edited: result.edited,
            bodyLength: result.bodyLength,
            provider: result.job.provider || '',
            model: result.job.model || '',
            simulated: !!(result.result && result.result.simulated),
            by: String(req.user._id),
          },
        });
        return res.json({
          success: true,
          job: result.job,
          message: result.message,
          result: result.result,
          edited: result.edited,
        });
      }

      default:
        return res.status(500).json({ success: false, message: 'Unexpected approval outcome' });
    }
  } catch (err) {
    return next(err);
  }
}

// DELETE /api/ai/jobs/:id   (any authenticated operator)
//
// Rejects/discards a draft. The record is NEVER deleted — it moves to the
// terminal `rejected` status so the decision stays auditable, and a rejected
// draft can never afterwards be approved.
async function rejectAiDraft(req, res, next) {
  try {
    const jobId = String(req.params.id || '');
    if (!OBJECT_ID.test(jobId)) {
      return res.status(400).json({ success: false, message: 'Invalid job id' });
    }

    const result = await aiService.rejectDraft({ jobId, rejectedBy: req.user._id });

    if (result.outcome === 'not_found') {
      return res.status(404).json({ success: false, message: 'AI draft not found' });
    }
    if (result.outcome === 'not_rejectable') {
      return res.status(409).json({
        success: false,
        message: `This draft cannot be discarded (status: ${result.status})`,
        status: result.status,
      });
    }

    // Only log the transition that actually happened. A repeat rejection is
    // reported as success but writes nothing and logs nothing, so retries cannot
    // pad the audit trail.
    if (!result.already) {
      await logEvent({
        eventType: 'ai.draft.rejected',
        severity: 'info',
        message: `${req.user.name || req.user.email} discarded an AI draft`,
        status: 'rejected',
        contact: result.job.contact,
        conversation: result.job.conversation,
        meta: { jobId, by: String(req.user._id) },
      });
    }

    return res.json({
      success: true,
      job: result.job,
      // False when the job was already rejected by an earlier identical request.
      changed: !result.already,
    });
  } catch (err) {
    return next(err);
  }
}

// PATCH /api/ai/conversations/:id   { mode: 'draft' | 'auto' }
//
// Sets the per-thread override of Settings.ai.defaultMode. The guardrails have
// always honoured this field (resolveMode); until now nothing could write it.
//
// It changes the mode and NOTHING else: the write is a single $set on 'ai.mode',
// so takeover, replyCount, escalation state, opt-out and every other field are
// untouched by construction rather than by care. It also triggers nothing — no
// generation, no send. The next inbound message is what starts work, under
// whichever mode is then in force.
async function setConversationAiMode(req, res, next) {
  try {
    const id = String(req.params.id || '');
    if (!OBJECT_ID.test(id)) {
      return res.status(400).json({ success: false, message: 'Invalid conversation id' });
    }

    const mode = req.body && req.body.mode;
    if (mode !== 'draft' && mode !== 'auto') {
      return res
        .status(400)
        .json({ success: false, message: "mode must be 'draft' or 'auto'" });
    }

    const convo = await Conversation.findOne({ _id: id, deletedAt: null });
    if (!convo) {
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }

    const previous = (convo.ai && convo.ai.mode) || '';
    // Targeted update: one path, nothing else in the ai subdocument is rewritten.
    await Conversation.updateOne({ _id: convo._id }, { $set: { 'ai.mode': mode } });

    await logEvent({
      // Switching a thread to 'auto' means the assistant may send to this person
      // without review, so that change is logged at a level an operator notices.
      eventType: 'ai.mode.changed',
      severity: mode === 'auto' ? 'warning' : 'info',
      message: `${req.user.name || req.user.email} set the AI mode for conversation ${convo._id} to ${mode}`,
      status: mode,
      contact: convo.contact,
      conversation: convo._id,
      meta: { from: previous, to: mode, by: String(req.user._id) },
    });

    const ai = convo.ai || {};
    return res.json({
      success: true,
      conversation: convo._id,
      state: {
        mode,
        // Returned unchanged, so a caller can see at a glance that nothing else moved.
        takeover: !!ai.takeover,
        replyCount: ai.replyCount || 0,
        escalated: !!ai.escalated,
      },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getAiSettings,
  updateAiSettings,
  testAiReply,
  getConversationAiState,
  enableTakeover,
  releaseTakeover,
  listAiJobs,
  presentAiSettings,
  approveAiDraft,
  rejectAiDraft,
  setConversationAiMode,
};

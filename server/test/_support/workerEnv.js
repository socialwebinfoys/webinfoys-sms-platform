// Phase 10 test harness — automation worker environment.
//
// Builds an in-memory substitute for the collections the worker touches. The
// stores are deliberately faithful about the two things the worker's safety
// depends on:
//
//   * claimEnrollment's filter `lockedUntil: { $not: { $gte: now } }`, including
//     the case where the field is ABSENT (legacy rows) — a naive `$lt` would not
//     match those and would freeze them forever.
//   * find(...).sort(...).limit(n) actually applying the limit, because the
//     per-run send budget is expressed through it.
//
// Call setupWorkerEnv() at the top of a worker test file, BEFORE requiring the
// worker, and use the returned handles to arrange each case.
'use strict';

require('./env');

const { stubModule, fakeModel, fakeDoc, query } = require('./stubs');
const f = require('./factories');
const { matches, applyUpdate } = require('./docStore');

function setupWorkerEnv() {
  // The default behaviours, kept as named functions so reset() can restore them.
  // A test that makes a send throw must not leak that into the next test.
  const defaultSendOutcome = () => ({
    sid: `SM${Math.random().toString(16).slice(2, 10)}`,
    status: 'queued',
    simulated: false,
    from: '+15005550006',
  });
  const defaultLookupResult = async () => ({
    valid: true,
    phone: '+14155552671',
    type: 'mobile',
    carrier: 'Test',
    lookedUpAt: new Date(),
  });

  const state = {
    settings: f.settings(),
    campaigns: new Map(), // id -> campaign
    contacts: new Map(), // id -> contact doc
    enrollments: [], // enrollment docs
    followings: [], // following docs
    conversations: [], // conversation docs
    createdMessages: [],
    logged: [],
    sendCalls: [],
    lookupCalls: [],
    locks: new Map(), // key -> { key, owner, expiresAt }
    // Overridable behaviours (restored by reset()).
    sendOutcome: defaultSendOutcome,
    lookupResult: defaultLookupResult,
  };

  stubModule('services/logService', {
    logEvent: async (event) => {
      state.logged.push(event);
    },
  });

  stubModule('services/twilioService', {
    sendSms: async (args) => {
      state.sendCalls.push(args);
      return state.sendOutcome(args);
    },
    isConfigured: () => true,
    status: () => ({ configured: true, simulate: true, accountSid: 'AC****abcd', from: '' }),
    PERMANENT_CODES: new Set([21610, 21211, 21614, 21408]),
  });

  stubModule('services/lookupService', {
    lookupNumber: async (phone) => {
      state.lookupCalls.push(phone);
      return state.lookupResult(phone);
    },
  });

  const RealSettings = require('../../models/Settings');
  stubModule(
    'models/Settings',
    fakeModel('Settings', {
      getSingleton: async () => state.settings,
      resolveAllowedLineTypes: RealSettings.resolveAllowedLineTypes,
      LINE_TYPES: RealSettings.LINE_TYPES,
    })
  );

  stubModule(
    'models/Campaign',
    fakeModel('Campaign', {
      find: (filter) => {
        let rows = [...state.campaigns.values()];
        if (filter && filter.isActive !== undefined) {
          rows = rows.filter((c) => c.isActive === filter.isActive);
        }
        return query(rows);
      },
      findById: (id) => query(state.campaigns.get(String(id)) || null),
    })
  );

  stubModule(
    'models/Contact',
    fakeModel('Contact', {
      findById: (id) => query(state.contacts.get(String(id)) || null),
      findOne: (filter) =>
        query(
          [...state.contacts.values()].find((c) => c.phone === (filter && filter.phone)) || null
        ),
      updateOne: async (filter, update) => {
        const doc = state.contacts.get(String(filter._id));
        if (doc && update.$set) Object.assign(doc, update.$set);
        return { modifiedCount: doc ? 1 : 0 };
      },
    })
  );

  // --- enrollments ---------------------------------------------------------
  function matchesDueFilter(doc, filter) {
    if (filter.status && doc.status !== filter.status) return false;
    if (filter.nextRunAt && filter.nextRunAt.$lte) {
      if (!(new Date(doc.nextRunAt).getTime() <= new Date(filter.nextRunAt.$lte).getTime())) {
        return false;
      }
    }
    if (filter.campaign && filter.campaign.$in) {
      const allowed = filter.campaign.$in.map(String);
      if (!allowed.includes(String(doc.campaign))) return false;
    }
    return true;
  }

  // A chainable query that genuinely honours sort() and limit().
  function listQuery(rows) {
    let result = rows;
    const chain = {
      sort(spec) {
        const [field] = Object.keys(spec || {});
        if (field) {
          const dir = spec[field] >= 0 ? 1 : -1;
          result = [...result].sort((a, b) => {
            const av = new Date(a[field]).getTime();
            const bv = new Date(b[field]).getTime();
            return (av - bv) * dir;
          });
        }
        return chain;
      },
      limit(n) {
        if (typeof n === 'number') result = result.slice(0, n);
        return chain;
      },
      select: () => chain,
      lean: () => chain,
      populate: () => chain,
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
      catch: (fn) => Promise.resolve(result).catch(fn),
    };
    return chain;
  }

  stubModule(
    'models/Enrollment',
    fakeModel('Enrollment', {
      find: (filter) => listQuery(state.enrollments.filter((e) => matchesDueFilter(e, filter || {}))),
      findById: (id) => query(state.enrollments.find((e) => String(e._id) === String(id)) || null),
      // Reproduce the atomic claim, including the absent-field case.
      findOneAndUpdate: async (filter, update) => {
        const doc = state.enrollments.find((e) => String(e._id) === String(filter._id));
        if (!doc) return null;
        if (filter.status && doc.status !== filter.status) return null;
        if (filter.lockedUntil && filter.lockedUntil.$not && filter.lockedUntil.$not.$gte) {
          const threshold = new Date(filter.lockedUntil.$not.$gte).getTime();
          const held = doc.lockedUntil !== undefined && doc.lockedUntil !== null;
          // $not: { $gte: now } matches when the value is absent OR below now.
          if (held && new Date(doc.lockedUntil).getTime() >= threshold) return null;
        }
        if (update.$set) Object.assign(doc, update.$set);
        return doc;
      },
      updateMany: async (filter, update) => {
        let n = 0;
        for (const doc of state.enrollments) {
          if (filter.contact && String(doc.contact) !== String(filter.contact)) continue;
          if (filter.status) {
            if (filter.status.$in && !filter.status.$in.includes(doc.status)) continue;
            if (typeof filter.status === 'string' && doc.status !== filter.status) continue;
          }
          Object.assign(doc, update.$set);
          n += 1;
        }
        return { modifiedCount: n };
      },
      updateOne: async () => ({ modifiedCount: 0 }),
    })
  );

  // --- followings ---------------------------------------------------------
  stubModule(
    'models/Following',
    fakeModel('Following', {
      find: (filter) =>
        listQuery(
          state.followings.filter((doc) => {
            if (filter.status && doc.status !== filter.status) return false;
            if (filter.nextRunAt && filter.nextRunAt.$lte) {
              return new Date(doc.nextRunAt).getTime() <= new Date(filter.nextRunAt.$lte).getTime();
            }
            return true;
          })
        ),
      updateMany: async (filter, update, options) => {
        // Only the "skip this contact's pending recipients" shape is used.
        let n = 0;
        const contactId =
          filter.recipients &&
          filter.recipients.$elemMatch &&
          String(filter.recipients.$elemMatch.contact);
        for (const doc of state.followings) {
          if (filter.stopOnReply && doc.stopOnReply === false) continue;
          for (const r of doc.recipients || []) {
            if (String(r.contact) === contactId && r.status === 'pending') {
              r.status = 'skipped';
              r.lastError = (update.$set && update.$set['recipients.$[r].lastError']) || '';
              n += 1;
            }
          }
        }
        return { modifiedCount: n };
      },
      // The worker claims each recipient and saves each result with a targeted
      // update, so these evaluate the REAL filter and apply the REAL update
      // (positional `$` included) against the stored follow-ups.
      updateOne: async (filter, update) => {
        const doc = state.followings.find((d) => matches(d, filter));
        if (!doc) return { matchedCount: 0, modifiedCount: 0 };
        applyUpdate(doc, update, filter);
        return { matchedCount: 1, modifiedCount: 1 };
      },
      countDocuments: async (filter) => state.followings.filter((d) => matches(d, filter)).length,
    })
  );

  // --- conversations: one thread per contact -----------------------------
  // findOneAndUpdate reproduces the upsert + $setOnInsert the model's static
  // relies on, and findOrCreateForContact is the REAL static run against this
  // store — so the worker is tested through the same mechanism production uses.
  const RealConversation = require('../../models/Conversation');
  const findConversation = (filter) =>
    state.conversations.find((c) =>
      filter._id !== undefined
        ? String(c._id) === String(filter._id)
        : String(c.contact) === String(filter.contact)
    ) || null;
  const ConversationModel = stubModule(
    'models/Conversation',
    fakeModel('Conversation', {
      findOne: async (filter) => findConversation(filter || {}),
      findById: async (id) => findConversation({ _id: id }),
      findOneAndUpdate: async (filter, update, options = {}) => {
        let doc = findConversation(filter);
        if (!doc && options.upsert) {
          doc = fakeDoc(
            f.conversation({
              _id: f.oid(),
              contact: filter.contact,
              unreadCount: 0,
              lastMessagePreview: '',
              lastMessageDirection: '',
              ...(update.$setOnInsert || {}),
            })
          );
          state.conversations.push(doc);
        }
        if (doc && update.$set) Object.assign(doc, update.$set);
        return doc;
      },
      findByIdAndUpdate: async (id, update) => {
        const doc = findConversation({ _id: id });
        if (!doc) return null;
        for (const [k, v] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + v;
        if (update.$set) Object.assign(doc, update.$set);
        return doc;
      },
      updateOne: async (filter, update) => {
        const doc = findConversation(filter);
        if (doc && update.$set) Object.assign(doc, update.$set);
        return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 };
      },
    })
  );
  ConversationModel.findOrCreateForContact = (contact) =>
    RealConversation.schema.statics.findOrCreateForContact.call(ConversationModel, contact);
  state.Conversation = ConversationModel;

  stubModule(
    'models/SMSMessage',
    fakeModel('SMSMessage', {
      create: async (doc) => {
        const saved = fakeDoc({ ...doc, _id: f.oid() });
        state.createdMessages.push(saved);
        return saved;
      },
      // Used when a follow-up recipient's earlier attempt was interrupted: was a
      // message to them already recorded?
      findOne: (filter) =>
        query(
          [...state.createdMessages].reverse().find((m) => matches(m, filter || {})) || null
        ),
    })
  );

  // --- worker lock: exercise the REAL acquire/release statics --------------
  const WorkerLock = require('../../models/WorkerLock');
  WorkerLock.findOneAndUpdate = async (filter, update) => {
    const existing = state.locks.get(filter.key);
    const now = Date.now();
    let free = !existing;
    if (existing) {
      const expired =
        filter.$or &&
        filter.$or.some(
          (clause) =>
            clause.expiresAt &&
            clause.expiresAt.$lte &&
            new Date(existing.expiresAt).getTime() <= new Date(clause.expiresAt.$lte).getTime()
        );
      const sameOwner =
        filter.$or && filter.$or.some((clause) => clause.owner && clause.owner === existing.owner);
      free = !!(expired || sameOwner);
    }
    if (!free) {
      const err = new Error('E11000 duplicate key error');
      err.code = 11000;
      throw err;
    }
    const next = { ...(existing || {}), ...update.$set };
    state.locks.set(filter.key, next);
    return next;
  };
  WorkerLock.updateOne = async (filter, update) => {
    const existing = state.locks.get(filter.key);
    if (existing && existing.owner === filter.owner) {
      Object.assign(existing, update.$set);
      return { modifiedCount: 1 };
    }
    return { modifiedCount: 0 };
  };

  stubModule('models/User', fakeModel('User'));
  for (const m of ['models/Import', 'models/Template', 'models/ImportPreview', 'models/SystemLog']) {
    stubModule(m, fakeModel(m));
  }

  // --- arrangement helpers -------------------------------------------------
  const DAY = 24 * 60 * 60 * 1000;

  state.addCampaign = (overrides = {}) => {
    const campaign = f.campaign(overrides);
    state.campaigns.set(String(campaign._id), campaign);
    return campaign;
  };

  // A contact with a fresh MOBILE classification so the line-type filter has a
  // definite answer without spending a Lookup call.
  state.addContact = (overrides = {}) => {
    const contact = fakeDoc(
      f.contact({
        _id: f.oid(),
        lookup: {
          status: 'valid',
          type: 'mobile',
          carrier: 'Test',
          canonicalPhone: '+14155552671',
          lookedUpAt: new Date(Date.now() - DAY),
        },
        ...overrides,
      })
    );
    state.contacts.set(String(contact._id), contact);
    return contact;
  };

  state.addEnrollment = (overrides = {}) => {
    const enrollment = fakeDoc(f.enrollment(overrides));
    state.enrollments.push(enrollment);
    return enrollment;
  };

  state.addFollowing = (overrides = {}) => {
    const following = fakeDoc({
      _id: f.oid(),
      name: 'Test Follow-up',
      import: f.oid(),
      contactIds: [],
      delayValue: 0,
      delayUnit: 'hours',
      body: 'Follow-up {{first_name}}',
      status: 'active',
      stopOnReply: true,
      activatedAt: new Date(Date.now() - DAY),
      nextRunAt: new Date(Date.now() - 1000),
      recipients: [],
      ...overrides,
    });
    state.followings.push(following);
    return following;
  };

  state.eventsOfType = (type) => state.logged.filter((e) => e.eventType === type);
  state.reset = () => {
    state.settings = f.settings();
    state.campaigns.clear();
    state.contacts.clear();
    state.enrollments.length = 0;
    state.followings.length = 0;
    state.conversations.length = 0;
    state.Conversation.__reset();
    state.createdMessages.length = 0;
    state.logged.length = 0;
    state.sendCalls.length = 0;
    state.lookupCalls.length = 0;
    state.locks.clear();
    // Critical: a test that made a send or a lookup throw must not leak that
    // behaviour into every test that follows it.
    state.sendOutcome = defaultSendOutcome;
    state.lookupResult = defaultLookupResult;
  };

  return state;
}

module.exports = { setupWorkerEnv };

// Phase 10 test harness — fixtures.
//
// Plain objects shaped like the real documents, with the same defaults the
// schemas apply. Ids are 24-hex strings so they survive the ObjectId-shape
// checks the controllers perform (e.g. logController's contact id guard).
'use strict';

let counter = 0;
function oid(seed) {
  counter += 1;
  const tail = String(seed === undefined ? counter : seed).padStart(6, '0');
  return `6a9a77ec9990e8f4bb${tail.slice(-6)}`;
}

function user(overrides = {}) {
  return {
    _id: overrides._id || oid(),
    name: 'Test User',
    email: 'user@test.invalid',
    role: 'user',
    isActive: true,
    ...overrides,
  };
}

function admin(overrides = {}) {
  return user({ name: 'Test Admin', email: 'admin@test.invalid', role: 'admin', ...overrides });
}

// A contact with every send-guard-relevant field explicitly set, so a test that
// cares about one of them is never accidentally relying on a default.
function contact(overrides = {}) {
  return {
    _id: overrides._id || oid(),
    name: 'Ada Lovelace',
    phone: '+14155552671',
    email: '',
    tags: [],
    isActive: true,
    optedOut: false,
    optedOutAt: undefined,
    optOutSource: '',
    deliveryBlocked: false,
    deliveryFailureCount: 0,
    timezone: '',
    lookup: { status: 'unknown', type: '', carrier: '', canonicalPhone: '', lookedUpAt: undefined },
    ...overrides,
  };
}

// Settings with the schema defaults, NOT the values currently in the live
// database — a test must state the configuration it depends on.
function settings(overrides = {}) {
  return {
    _id: oid(),
    key: 'twilio',
    smsEnabled: true,
    mobileOnly: false,
    allowedLineTypes: undefined,
    lookupMaxAgeDays: 30,
    defaultFrom: '',
    sendingWindow: { enabled: true, startHour: 9, endHour: 20, timezone: 'America/New_York' },
    sendDays: [0, 1, 2, 3, 4, 5, 6],
    maxSendsPerRun: null,
    deliveryFailureThreshold: 3,
    ...overrides,
  };
}

function campaign(overrides = {}) {
  const steps = overrides.steps || [
    { _id: oid(), body: 'Step one {{first_name}}', delayValue: 0, delayUnit: 'hours' },
  ];
  return {
    _id: overrides._id || oid(),
    name: 'Test Campaign',
    description: '',
    isActive: true,
    import: oid(),
    ...overrides,
    steps,
  };
}

function enrollment(overrides = {}) {
  return {
    _id: overrides._id || oid(),
    contact: oid(),
    campaign: oid(),
    status: 'active',
    currentStepId: null,
    currentStepIndex: 0,
    nextRunAt: new Date(0),
    attempts: 0,
    lastError: '',
    stopReason: '',
    sentSteps: [],
    timezone: '',
    lockedUntil: new Date(0),
    ...overrides,
  };
}

function conversation(overrides = {}) {
  return {
    _id: overrides._id || oid(),
    contact: oid(),
    status: 'open',
    assignedTo: null,
    unreadCount: 0,
    lastMessageAt: new Date(),
    lastMessagePreview: '',
    lastMessageDirection: '',
    contactName: 'Ada Lovelace',
    contactPhone: '+14155552671',
    deletedAt: null,
    ...overrides,
  };
}

function smsMessage(overrides = {}) {
  return {
    _id: overrides._id || oid(),
    direction: 'outbound',
    to: '+14155552671',
    from: '+15005550006',
    body: 'hello',
    twilioSid: 'SM00000000000000000000000000000001',
    status: 'queued',
    source: 'manual',
    deletedAt: null,
    // The schema sets timestamps:true, so a real message always carries this.
    // It was missing here, which made fixtures subtly unlike the documents the
    // code actually sees — and Fix 2 compares message times, so a message with
    // no timestamp is one whose position in the thread cannot be established.
    createdAt: new Date(),
    ...overrides,
  };
}

module.exports = {
  oid,
  user,
  admin,
  contact,
  settings,
  campaign,
  enrollment,
  conversation,
  smsMessage,
};

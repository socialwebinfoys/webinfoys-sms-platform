// System event log listing. Read-only, paginated, filterable, searchable.
const SystemLog = require('../models/SystemLog');
const { queryString } = require('../utils/queryGuards');

const MAX_LIMIT = 100;

// Escape a user-supplied string so it is matched literally inside a RegExp.
// Without this, a search for "a+b" or "(" is either a different query than the
// operator intended or an outright regex-injection / ReDoS vector.
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// GET /api/logs?eventType=&severity=&from=&to=&search=&contact=&page=&limit=
async function listLogs(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), MAX_LIMIT);
    const skip = (page - 1) * limit;

    const filter = {};
    // Coerce to a string so a query-operator object cannot be injected into the
    // filter (defense-in-depth; this endpoint is read-only and authenticated).
    if (req.query.eventType) filter.eventType = queryString(req.query.eventType);

    // Phase 10: narrow to a family of events, e.g. eventPrefix=ai. for every AI
    // event. Added because the AI activity table needs exactly the `ai.*` events
    // and nothing else: `search` also matches the human-readable message, so a
    // message that happened to contain "ai." would be pulled in.
    //
    // Anchored and escaped, so the term is matched literally and MongoDB can
    // still serve it from the eventType index (a ^-anchored regex is indexable).
    // Ignored when an exact eventType was given, which is the narrower filter.
    const eventPrefix = queryString(req.query.eventPrefix);
    if (eventPrefix && !filter.eventType) {
      filter.eventType = new RegExp(`^${escapeRegex(eventPrefix)}`);
    }
    if (['info', 'warning', 'error'].includes(req.query.severity)) filter.severity = req.query.severity;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }

    // Phase 7: free-text search across the human-readable message and the dotted
    // event name, so "optout" finds optout.received and "blocked" finds the
    // messages that say so. The term is escaped, so regex metacharacters are
    // matched literally and cannot alter the query.
    const search = queryString(req.query.search);
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ message: re }, { eventType: re }, { status: re }];
    }

    // Phase 7: narrow to one contact's events. Coerced to a single string; a
    // malformed id yields a clean 400 from Mongoose's cast rather than matching
    // everything.
    const contactId = queryString(req.query.contact);
    if (contactId) {
      if (!/^[0-9a-fA-F]{24}$/.test(contactId)) {
        return res.status(400).json({ success: false, message: 'Invalid contact id' });
      }
      filter.contact = contactId;
    }

    const [items, total] = await Promise.all([
      SystemLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('contact', 'name phone')
        .populate('campaign', 'name'),
      SystemLog.countDocuments(filter),
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

module.exports = { listLogs };

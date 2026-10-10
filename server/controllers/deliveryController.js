// Delivery reporting (Phase 3). Read-only aggregate view of what actually
// reached handsets, plus the admin action to clear a delivery block.
//
// "Delivered" here means Twilio told us so via a status callback — not merely
// that Twilio accepted the message. Everything is computed with MongoDB
// aggregation; nothing is loaded into memory.
const SMSMessage = require('../models/SMSMessage');
const Contact = require('../models/Contact');
const { describeCode } = require('../services/deliveryPolicy');
const { logEvent } = require('../services/logService');

// Statuses that represent a finished delivery attempt, i.e. the denominator of
// the delivery rate. Anything still queued/sent is awaiting a receipt.
const DELIVERED = 'delivered';
const FAILED_STATUSES = ['undelivered', 'failed'];

function rate(numerator, denominator) {
  if (!denominator || denominator <= 0) return 0;
  return numerator / denominator;
}

// GET /api/delivery/report?days=30
async function getDeliveryReport(req, res, next) {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const match = { direction: 'outbound', createdAt: { $gte: since } };

    const [byStatus, byErrorCode, recentFailures, blockedContacts, blockedTotal] =
      await Promise.all([
        SMSMessage.aggregate([
          { $match: match },
          { $group: { _id: '$status', n: { $sum: 1 } } },
        ]),
        SMSMessage.aggregate([
          { $match: { ...match, errorCode: { $ne: null, $exists: true } } },
          { $group: { _id: '$errorCode', n: { $sum: 1 } } },
          { $sort: { n: -1 } },
          { $limit: 10 },
        ]),
        SMSMessage.find({ ...match, status: { $in: FAILED_STATUSES } })
          .sort({ statusUpdatedAt: -1, createdAt: -1 })
          .limit(25)
          .populate('contact', 'name phone')
          .select('to status errorCode createdAt statusUpdatedAt contact source'),
        Contact.find({ deliveryBlocked: true })
          .sort({ deliveryBlockedAt: -1 })
          .limit(100)
          .select('name phone deliveryBlockedAt deliveryFailureCount lastDeliveryStatus lastDeliveryErrorCode'),
        Contact.countDocuments({ deliveryBlocked: true }),
      ]);

    const counts = {};
    let total = 0;
    byStatus.forEach((r) => {
      const key = r._id || 'unknown';
      counts[key] = (counts[key] || 0) + r.n;
      total += r.n;
    });

    const delivered = counts[DELIVERED] || 0;
    const undelivered = counts.undelivered || 0;
    const failed = counts.failed || 0;
    // Messages Twilio accepted but has not reported on yet.
    const awaiting = total - delivered - undelivered - failed;
    const finished = delivered + undelivered + failed;

    return res.json({
      success: true,
      days,
      since,
      generatedAt: new Date(),
      totals: {
        outbound: total,
        delivered,
        undelivered,
        failed,
        awaiting: awaiting < 0 ? 0 : awaiting,
        blocked: blockedTotal,
      },
      // delivered / (delivered + undelivered + failed) — receipts only, so
      // messages still in flight neither help nor hurt the rate.
      deliveryRate: rate(delivered, finished),
      byStatus: counts,
      errorCodes: byErrorCode.map((r) => ({
        code: r._id,
        count: r.n,
        meaning: describeCode(r._id),
      })),
      recentFailures: recentFailures.map((m) => ({
        _id: m._id,
        to: m.to,
        status: m.status,
        errorCode: m.errorCode,
        meaning: describeCode(m.errorCode),
        source: m.source,
        contact: m.contact,
        at: m.statusUpdatedAt || m.createdAt,
      })),
      blockedContacts,
    });
  } catch (err) {
    return next(err);
  }
}

// PATCH /api/delivery/unblock/:contactId   (admin)
// Clears a delivery block and resets the consecutive-failure counter so the
// contact starts from a clean slate. Deliberately does NOT touch opt-out state:
// a contact who opted out stays opted out.
async function unblockContact(req, res, next) {
  try {
    const contact = await Contact.findById(req.params.contactId);
    if (!contact) {
      return res.status(404).json({ success: false, message: 'Contact not found' });
    }
    if (!contact.deliveryBlocked) {
      return res
        .status(400)
        .json({ success: false, message: 'This contact is not delivery blocked' });
    }

    contact.deliveryBlocked = false;
    contact.deliveryBlockedAt = undefined;
    contact.deliveryFailureCount = 0;
    await contact.save();

    const operator = req.user ? req.user.name || req.user.email : 'unknown operator';
    await logEvent({
      eventType: 'delivery.unblocked',
      severity: 'info',
      message: `${operator} cleared the delivery block on ${contact.phone}`,
      status: 'unblocked',
      contact: contact._id,
      meta: { by: operator, byUserId: req.user ? String(req.user._id) : undefined },
    });

    return res.json({ success: true, data: contact });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getDeliveryReport, unblockContact };

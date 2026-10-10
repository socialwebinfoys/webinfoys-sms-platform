// Operator accounts.
//
// GET /api/users is used by the inbox assignment dropdown and by the admin
// Team page; PATCH /api/users/:id is admin-only account management.
//
// The User model's toJSON already strips the password hash and __v, and every
// query here selects an explicit field list as well — a password hash must
// never leave the server, even by accident.
const User = require('../models/User');
const { logEvent } = require('../services/logService');
const { queryBool } = require('../utils/queryGuards');

// Fields an ADMIN may see. Deliberately explicit rather than "everything except
// password", so a future field is private until someone opts it in.
const PUBLIC_FIELDS = 'name email role isActive createdAt updatedAt';

// Bug #3: what a NON-ADMIN may see. The only reason an ordinary operator fetches
// this list is the inbox assignment dropdown, which renders a name against an
// id; it has never needed anyone's email address, account state or timestamps.
// Handing every operator the full staff directory is an avoidable disclosure, so
// the projection is narrowed to exactly what the UI consumes (_id is included by
// default in a Mongoose projection).
const NON_ADMIN_FIELDS = 'name role';

// Phase 7: mirrors the registration minimum (authController.MIN_PASSWORD_LENGTH)
// so a password reset cannot sidestep the policy a new account must meet.
const MIN_PASSWORD_LENGTH = 12;
const ROLES = ['admin', 'user'];

// GET /api/users?includeInactive=true  (protected)
// Default: active operators only — that is what the assignment dropdown wants.
// Admins pass includeInactive=true on the Team page to see deactivated accounts.
async function listUsers(req, res, next) {
  try {
    const isAdmin = !!(req.user && req.user.role === 'admin');
    const includeInactive = queryBool(req.query.includeInactive) === true;
    // Only an admin may see deactivated accounts.
    const canSeeInactive = includeInactive && isAdmin;

    const filter = canSeeInactive ? {} : { isActive: true };
    // Bug #3: an ordinary operator gets only { _id, name, role }.
    const projection = isAdmin ? PUBLIC_FIELDS : NON_ADMIN_FIELDS;
    const users = await User.find(filter).select(projection).sort('name');
    return res.json({ success: true, data: users });
  } catch (err) {
    return next(err);
  }
}

// PATCH /api/users/:id   (admin only)
// Body may contain any of: { role, isActive, password }.
//
// SELF-PROTECTION. An admin may not remove their own access, because doing so
// could leave an installation with no administrator at all and no way back in:
//   * cannot deactivate yourself
//   * cannot demote yourself out of the admin role
// Resetting your own password IS allowed — that is a normal thing to want.
async function updateUser(req, res, next) {
  try {
    const target = await User.findById(req.params.id).select(`${PUBLIC_FIELDS} +password`);
    if (!target) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const { role, isActive, password } = req.body || {};
    const isSelf = String(target._id) === String(req.user._id);
    const changes = [];

    if (role !== undefined) {
      if (!ROLES.includes(role)) {
        return res
          .status(400)
          .json({ success: false, message: `role must be one of ${ROLES.join(', ')}` });
      }
      if (isSelf && target.role === 'admin' && role !== 'admin') {
        return res.status(400).json({
          success: false,
          message:
            'You cannot remove your own admin role. Ask another administrator to change it.',
        });
      }
      if (target.role !== role) changes.push(`role ${target.role} -> ${role}`);
      target.role = role;
    }

    if (isActive !== undefined) {
      const next = !!isActive;
      if (isSelf && next === false) {
        return res.status(400).json({
          success: false,
          message: 'You cannot deactivate your own account.',
        });
      }
      if (target.isActive !== next) changes.push(next ? 'reactivated' : 'deactivated');
      target.isActive = next;
    }

    if (password !== undefined) {
      if (typeof password !== 'string') {
        return res.status(400).json({ success: false, message: 'password must be a text value' });
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({
          success: false,
          message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        });
      }
      // Assigning the plaintext triggers the model's pre-save hash hook; the
      // plaintext itself is never stored and never logged.
      target.password = password;
      changes.push('password reset');
    }

    if (changes.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: 'Nothing to update (send role, isActive or password)' });
    }

    await target.save();

    // The event records WHAT changed, never the new password.
    await logEvent({
      eventType: 'user.updated',
      severity: 'warning',
      message: `${req.user.name || req.user.email} updated ${target.email}: ${changes.join(', ')}`,
      status: 'updated',
      meta: {
        targetUserId: String(target._id),
        targetEmail: target.email,
        changes,
        by: String(req.user._id),
      },
    });

    // Re-read through the public projection so no hash can ride along.
    const safe = await User.findById(target._id).select(PUBLIC_FIELDS);
    return res.json({ success: true, data: safe });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listUsers,
  updateUser,
  MIN_PASSWORD_LENGTH,
  PUBLIC_FIELDS,
  NON_ADMIN_FIELDS,
};

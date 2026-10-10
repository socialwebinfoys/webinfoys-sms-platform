// Resolves the outbound message for a Campaign step or a Following from EITHER a
// selected Template OR a custom body — exactly one is required (never both).
// Reused by the campaign and following controllers so the "template vs custom
// message" behaviour is identical in both, and so the existing Template model is
// the single source of template content.
const Template = require('../models/Template');

// input:  { templateId, body }
// output: { body, template } on success (template is an ObjectId or undefined),
//         or { error } with a safe validation message.
// When a template is chosen, its current body is snapshotted into `body` (the
// same copy-at-build behaviour the campaign builder already used), so later
// edits/deletion of the template never change or break an existing record. Merge
// fields inside the body are rendered later by the existing merge-field engine.
async function resolveMessage({ templateId, body }) {
  const hasTemplate =
    templateId !== undefined && templateId !== null && String(templateId).trim() !== '';
  const trimmedBody = typeof body === 'string' ? body.trim() : '';

  if (hasTemplate) {
    let tpl;
    try {
      tpl = await Template.findById(templateId);
    } catch (e) {
      // Malformed id, etc. — treat as "not found" rather than a server error.
      return { error: 'Selected template not found' };
    }
    if (!tpl) return { error: 'Selected template not found' };
    return { body: tpl.body, template: tpl._id };
  }

  if (trimmedBody) {
    return { body: trimmedBody, template: undefined };
  }

  return { error: 'Provide a template or a custom message body' };
}

module.exports = { resolveMessage };

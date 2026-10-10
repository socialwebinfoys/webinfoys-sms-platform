// Template management: CRUD plus a merge-field preview.
const Template = require('../models/Template');
const Contact = require('../models/Contact');
const {
  extractMergeFields,
  renderTemplate,
  contactToMergeData,
} = require('../utils/mergeFields');
const { queryString, pickSort } = require('../utils/queryGuards');

const MAX_LIMIT = 100;
// Phase 0: allow-listed sort fields for the template list.
const TEMPLATE_SORT_FIELDS = ['createdAt', 'name'];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// GET /api/templates  (search, page, limit)
async function listTemplates(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_LIMIT);
    const skip = (page - 1) * limit;

    const filter = {};
    // Phase 0: coerced to a single string, so repeated or object-shaped
    // parameters neither crash the handler nor reach the Mongo filter.
    const search = queryString(req.query.search);
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ name: re }, { description: re }, { body: re }];
    }

    const { sort, invalid } = pickSort(req.query.sort, TEMPLATE_SORT_FIELDS);
    if (invalid) {
      return res.status(400).json({
        success: false,
        message: `Invalid sort "${invalid}". Allowed fields: ${TEMPLATE_SORT_FIELDS.join(', ')} (prefix with "-" for descending).`,
      });
    }

    const [items, total] = await Promise.all([
      Template.find(filter).sort(sort).skip(skip).limit(limit),
      Template.countDocuments(filter),
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

// GET /api/templates/options
//
// Phase 7: a lightweight list for pickers (campaign step builder, follow-up
// composer, inbox template popover). The paginated /api/templates endpoint caps
// at 100 per page, so an account with more templates could not see them all in a
// dropdown. This returns id + name ONLY — never the bodies — so the payload
// stays small no matter how many templates exist.
const OPTIONS_CAP = 1000;
async function listTemplateOptions(req, res, next) {
  try {
    const items = await Template.find({})
      .select('name')
      .sort('name')
      .limit(OPTIONS_CAP)
      .lean();
    const total = await Template.countDocuments({});
    return res.json({
      success: true,
      data: items.map((t) => ({ _id: t._id, name: t.name })),
      total,
      // True when there are more templates than the cap, so a caller knows the
      // list is not exhaustive rather than silently missing entries.
      truncated: total > OPTIONS_CAP,
      cap: OPTIONS_CAP,
    });
  } catch (err) {
    return next(err);
  }
}

// GET /api/templates/:id
async function getTemplate(req, res, next) {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    return res.json({
      success: true,
      data: template,
      mergeFields: extractMergeFields(template.body),
    });
  } catch (err) {
    return next(err);
  }
}

// POST /api/templates
async function createTemplate(req, res, next) {
  try {
    const { name, description, body } = req.body || {};
    if (!name || !body) {
      return res
        .status(400)
        .json({ success: false, message: 'Name and body are required' });
    }
    const template = await Template.create({
      name,
      description: description || '',
      body,
      createdBy: req.user ? req.user._id : undefined,
    });
    return res.status(201).json({
      success: true,
      data: template,
      mergeFields: extractMergeFields(template.body),
    });
  } catch (err) {
    return next(err);
  }
}

// PUT /api/templates/:id
async function updateTemplate(req, res, next) {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    const { name, description, body } = req.body || {};
    if (name !== undefined) template.name = name;
    if (description !== undefined) template.description = description;
    if (body !== undefined) template.body = body;

    await template.save();
    return res.json({
      success: true,
      data: template,
      mergeFields: extractMergeFields(template.body),
    });
  } catch (err) {
    return next(err);
  }
}

// DELETE /api/templates/:id
async function deleteTemplate(req, res, next) {
  try {
    const template = await Template.findByIdAndDelete(req.params.id);
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    return res.json({ success: true, message: 'Template deleted' });
  } catch (err) {
    return next(err);
  }
}

// POST /api/templates/preview
// Body: { body? , templateId? , contactId? , data? }
// Renders a template body with merge data (sample data and/or a real contact).
// This does NOT send anything — it is a preview only.
async function previewTemplate(req, res, next) {
  try {
    const { body, templateId, contactId, data } = req.body || {};

    let text = body;
    if (!text && templateId) {
      const template = await Template.findById(templateId);
      if (!template) {
        return res.status(404).json({ success: false, message: 'Template not found' });
      }
      text = template.body;
    }
    if (text === undefined || text === null) {
      return res
        .status(400)
        .json({ success: false, message: 'Provide a body or a templateId to preview' });
    }

    let mergeData = {};
    if (contactId) {
      const contact = await Contact.findById(contactId);
      if (!contact) {
        return res.status(404).json({ success: false, message: 'Contact not found' });
      }
      mergeData = contactToMergeData(contact);
    }
    // Explicit data overrides contact-derived values.
    if (data && typeof data === 'object') {
      mergeData = { ...mergeData, ...data };
    }

    const { rendered, unresolved } = renderTemplate(text, mergeData);
    return res.json({
      success: true,
      rendered,
      mergeFields: extractMergeFields(text),
      unresolved,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listTemplateOptions,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  previewTemplate,
};

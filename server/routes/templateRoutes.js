// Template routes: /api/templates/*. All protected.
const express = require('express');
const {
  listTemplateOptions,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  previewTemplate,
} = require('../controllers/templateController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

router.post('/preview', previewTemplate);
router.route('/').get(listTemplates).post(createTemplate);
// Phase 7: lightweight id+name list for dropdowns. Must precede '/:id'.
router.get('/options', listTemplateOptions);

router.route('/:id').get(getTemplate).put(updateTemplate).delete(deleteTemplate);

module.exports = router;

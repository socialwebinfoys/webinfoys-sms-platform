// Contact routes: maps /api/contacts/* to controller functions. All routes are
// protected (require a valid JWT).
const express = require('express');
const multer = require('multer');

const {
  listContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  deleteAllContacts,
  importContacts,
  previewImport,
  confirmImport,
  lookupContact,
  setOptOut,
  lookupSummary,
  startLookupAll,
  lookupAllStatus,
  bulkDeleteContacts,
  deleteInvalidContacts,
} = require('../controllers/contactController');
const { protect, authorize } = require('../middleware/authMiddleware');

const router = express.Router();

// Uploaded files are held in memory and parsed from the buffer (no disk writes).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    if (name.endsWith('.csv') || name.endsWith('.xlsx')) return cb(null, true);
    return cb(new Error('Only .csv and .xlsx files are allowed'));
  },
});

// Wrap multer so upload errors (bad file type, too large) return a clean 400
// instead of falling through to the generic 500 error handler.
function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    return next();
  });
}

router.use(protect);

// Phase 0: DELETE / wipes EVERY contact — admin only. Destructive bulk routes
// are declared with their guard inline so the authorization is visible here.
// Lookup counts and Lookup All. Literal paths, declared before '/:id'.
router.get('/lookup-summary', lookupSummary);
router.get('/lookup-all/status', lookupAllStatus);
// Lookup All is a billable bulk action: admin only.
router.post('/lookup-all', authorize('admin'), startLookupAll);
// Bulk deletes are destructive bulk routes: admin only (Phase 0 rule).
router.post('/bulk-delete', authorize('admin'), bulkDeleteContacts);
router.post('/delete-invalid', authorize('admin'), deleteInvalidContacts);
router.route('/').get(listContacts).post(createContact).delete(authorize('admin'), deleteAllContacts);
// Phase 6: preview (no writes) then confirm. Declared before '/import' is not
// required by Express, but keeping the three together makes the flow obvious.
router.post('/import/preview', uploadSingle, previewImport);
router.post('/import/confirm', confirmImport);
// Back-compat one-shot import: same engine, preview + confirm in one request.
router.post('/import', uploadSingle, importContacts);
router.post('/:id/lookup', lookupContact);
// Manual opt-out / opt-in toggle (Phase 1). Any authenticated operator.
router.patch('/:id/opt-out', setOptOut);
router.route('/:id').get(getContact).put(updateContact).delete(deleteContact);

module.exports = router;

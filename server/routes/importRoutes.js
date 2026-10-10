// Contact-import routes: /api/contact-imports. Protected; listing for the
// campaign "contact list / CSV" picker, plus deletion of an import (CSV list)
// record. Deletion removes only the import record — never its contacts or any
// campaign/enrollment/SMS history.
const express = require('express');
const { listImports, deleteImport, getAllocation, allocate, deleteBatch } = require('../controllers/importController');
const { protect, authorize } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);
router.get('/', listImports);
// Batch allocation: the list as a persistent queue. Any signed-in operator, like
// enrolling — it never deletes anything.
router.get('/:id/allocation', getAllocation);
router.post('/:id/allocate', allocate);
// Deleting a batch grouping is admin-only, like deleting an import record.
router.delete('/:id/batches/:batchId', authorize('admin'), deleteBatch);
// Phase 0: deleting an import record is destructive metadata loss — admin only.
router.delete('/:id', authorize('admin'), deleteImport);

module.exports = router;

// Delivery routes: /api/delivery/*. Protected; the report is read-only for any
// authenticated operator, while clearing a delivery block is admin-only.
const express = require('express');
const { getDeliveryReport, unblockContact } = require('../controllers/deliveryController');
const { protect, authorize } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);
router.get('/report', getDeliveryReport);
router.patch('/unblock/:contactId', authorize('admin'), unblockContact);

module.exports = router;

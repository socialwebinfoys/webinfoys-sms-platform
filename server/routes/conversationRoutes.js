// Conversation / inbox routes: /api/conversations/*. All protected (shared team
// inbox — every authenticated operator has access). Deletion is admin-only.
const express = require('express');
const {
  listConversations,
  getConversation,
  getMessages,
  reply,
  updateConversation,
  markRead,
  getUnreadCount,
  getChanges,
  deleteMessage,
  deleteConversation,
  bulkDeleteConversations,
  deleteAllConversations,
} = require('../controllers/conversationController');
const { protect, authorize } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Literal paths must be declared before '/:id', otherwise Express would treat
// "unread-count" and "changes" as conversation ids.
router.get('/unread-count', getUnreadCount);
router.get('/changes', getChanges);
router.delete('/messages/:messageId', authorize('admin'), deleteMessage);
// Bulk deletion — admin-only, the same soft delete as DELETE /:id.
router.post('/bulk-delete', authorize('admin'), bulkDeleteConversations);
router.post('/delete-all', authorize('admin'), deleteAllConversations);

router.get('/', listConversations);
router.get('/:id', getConversation);
router.patch('/:id', updateConversation);
router.delete('/:id', authorize('admin'), deleteConversation);
router.get('/:id/messages', getMessages);
router.post('/:id/reply', reply);
router.post('/:id/read', markRead);

module.exports = router;

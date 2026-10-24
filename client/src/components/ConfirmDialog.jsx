// Reusable confirmation dialog for destructive actions (single + bulk deletes).
// Built on the existing Modal so it matches the app's dark theme. Presentational.
import Modal from './Modal';

export default function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Delete',
  busy = false,
  // Extra gate on the confirm button (e.g. a phrase that must be typed first).
  confirmDisabled = false,
  danger = true,
  onConfirm,
  onClose,
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="confirm-msg">{message}</div>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className={danger ? 'btn btn-danger' : 'btn btn-primary'}
          onClick={onConfirm}
          disabled={busy || confirmDisabled}
          autoFocus
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

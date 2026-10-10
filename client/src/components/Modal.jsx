// Minimal reusable modal dialog. Pass `wide` for larger content (e.g. builders).
export default function Modal({ title, onClose, children, wide = false }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={wide ? 'modal modal-wide' : 'modal'} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

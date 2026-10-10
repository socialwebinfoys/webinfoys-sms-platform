// Small, consistent loading indicator used across the app. Presentational only.
export default function Spinner({ label = 'Loading…', large = false, inline = false }) {
  if (inline) {
    return <span className={large ? 'spinner lg' : 'spinner'} role="status" aria-label={label} />;
  }
  return (
    <div className="state" role="status" aria-live="polite">
      <span className={large ? 'spinner lg' : 'spinner'} aria-hidden="true" />
      {label && <div className="state-hint">{label}</div>}
    </div>
  );
}

// Consistent "nothing here yet" placeholder. Explains what is empty and,
// where useful, what the user can do next. Presentational only.
export default function EmptyState({ icon, title, hint, action }) {
  return (
    <div className="state">
      {icon && <div className="state-icon">{icon}</div>}
      {title && <div className="state-title">{title}</div>}
      {hint && <div className="state-hint">{hint}</div>}
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  );
}

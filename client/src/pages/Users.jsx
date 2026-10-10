// Team management (Phase 7, admin only).
//
// Every control here is backed by a server-side admin check — this page hides
// nothing that the API does not also refuse. Non-admins are shown an explicit
// message rather than an empty page, so the restriction is legible.
import { useEffect, useState, useCallback } from 'react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import ConfirmDialog from '../components/ConfirmDialog';

const MIN_PASSWORD = 12;

const UsersIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

export default function Users() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [includeInactive, setIncludeInactive] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'user' });
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const [resetFor, setResetFor] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/users', { params: { includeInactive: includeInactive || undefined } });
      setRows(data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load the team');
    } finally {
      setLoading(false);
    }
  }, [isAdmin, includeInactive]);

  useEffect(() => { load(); }, [load]);

  const createUser = async (e) => {
    e.preventDefault();
    setFormError('');
    if (form.password.length < MIN_PASSWORD) {
      setFormError(`Password must be at least ${MIN_PASSWORD} characters`);
      return;
    }
    setSaving(true);
    try {
      await api.post('/auth/register', form);
      setNotice(`Created ${form.email}.`);
      setCreateOpen(false);
      setForm({ name: '', email: '', password: '', role: 'user' });
      load();
    } catch (err) {
      setFormError(err.response?.data?.message || 'Could not create that operator');
    } finally {
      setSaving(false);
    }
  };

  const patchUser = async (id, body, successMessage) => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await api.patch(`/users/${id}`, body);
      setNotice(successMessage);
      load();
    } catch (err) {
      setError(err.response?.data?.message || 'Update failed');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const submitReset = async (e) => {
    e.preventDefault();
    if (newPassword.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters`);
      return;
    }
    await patchUser(resetFor._id, { password: newPassword }, `Password reset for ${resetFor.email}.`);
    setResetFor(null);
    setNewPassword('');
  };

  if (!isAdmin) {
    return (
      <div className="page">
        <div className="page-head">
          <div>
            <h1>Team</h1>
            <div className="page-sub">Operator accounts.</div>
          </div>
        </div>
        <EmptyState
          icon={UsersIcon}
          title="Administrators only"
          hint="Managing operator accounts requires an administrator. Ask an admin if you need access changed."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Team</h1>
          <div className="page-sub">Operator accounts, roles and access.</div>
        </div>
        <div className="head-actions">
          <button className="btn btn-primary" onClick={() => { setFormError(''); setCreateOpen(true); }}>
            + Add operator
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-info">{notice}</div>}

      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={includeInactive}
          onChange={(e) => setIncludeInactive(e.target.checked)}
        />
        <span>Show deactivated accounts</span>
      </label>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5}><Spinner label="Loading team…" /></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={5}><EmptyState icon={UsersIcon} title="No operators" hint="Add an operator to get started." /></td></tr>
            ) : (
              rows.map((u) => {
                const isSelf = String(u._id) === String(user._id);
                return (
                  <tr key={u._id}>
                    <td>
                      {u.name}
                      {isSelf && <span className="muted small"> (you)</span>}
                    </td>
                    <td className="small">{u.email}</td>
                    <td>
                      <select
                        className="input"
                        value={u.role}
                        disabled={isSelf || busy}
                        title={isSelf ? 'You cannot change your own role' : 'Change role'}
                        onChange={(e) => patchUser(u._id, { role: e.target.value }, `${u.email} is now ${e.target.value}.`)}
                      >
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td>
                      <span className={u.isActive ? 'chip chip-on' : 'chip chip-invalid'}>
                        {u.isActive ? 'active' : 'deactivated'}
                      </span>
                    </td>
                    <td className="row-actions">
                      <button className="btn btn-sm" disabled={busy} onClick={() => { setResetFor(u); setNewPassword(''); }}>
                        Reset password
                      </button>
                      {u.isActive ? (
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={isSelf || busy}
                          title={isSelf ? 'You cannot deactivate your own account' : 'Deactivate'}
                          onClick={() => setConfirm({ user: u })}
                        >
                          Deactivate
                        </button>
                      ) : (
                        <button
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() => patchUser(u._id, { isActive: true }, `${u.email} reactivated.`)}
                        >
                          Reactivate
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {createOpen && (
        <Modal title="Add operator" onClose={() => setCreateOpen(false)}>
          <form onSubmit={createUser}>
            {formError && <div className="alert alert-error">{formError}</div>}
            <label className="field">
              <span>Name *</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label className="field">
              <span>Email *</span>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </label>
            <label className="field">
              <span>Password * (at least {MIN_PASSWORD} characters)</span>
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                minLength={MIN_PASSWORD}
                required
              />
              <span className="muted small">
                Give this to the operator over a secure channel. It is never shown again.
              </span>
            </label>
            <label className="field">
              <span>Role</span>
              <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="user">user — day-to-day operator</option>
                <option value="admin">admin — can also manage settings, deletions and the team</option>
              </select>
            </label>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setCreateOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Creating…' : 'Create operator'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {resetFor && (
        <Modal title={`Reset password for ${resetFor.email}`} onClose={() => setResetFor(null)}>
          <form onSubmit={submitReset}>
            <label className="field">
              <span>New password (at least {MIN_PASSWORD} characters)</span>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={MIN_PASSWORD}
                required
              />
            </label>
            <div className="muted small">
              The operator is signed out of nothing automatically — their existing session
              stays valid until it expires. Tell them the new password securely.
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setResetFor(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? 'Saving…' : 'Reset password'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {confirm && (
        <ConfirmDialog
          title="Deactivate this operator?"
          confirmLabel="Deactivate"
          busy={busy}
          onConfirm={() => patchUser(confirm.user._id, { isActive: false }, `${confirm.user.email} deactivated.`)}
          onClose={() => setConfirm(null)}
          message={
            <p>
              <strong>{confirm.user.email}</strong> will no longer be able to sign in. Their
              account, assignments and history are kept, and you can reactivate them at any time.
            </p>
          }
        />
      )}
    </div>
  );
}

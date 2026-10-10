// Following screen: configure and manage automated follow-ups. A Following sends
// one message (template or custom) to selected contacts from one CSV/import,
// after a delay measured from activation, executed by the shared automation
// worker. Mirrors the existing Campaigns/Enrollments UI patterns and components.
import { useEffect, useState, useCallback, useRef } from 'react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import ConfirmDialog from '../components/ConfirmDialog';
import SmsCounter from '../components/SmsCounter';

const FollowingIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" />
  </svg>
);

const LIST_LIMIT = 100;
const emptyForm = () => ({ name: '', importId: '', delayValue: 24, delayUnit: 'hours', templateId: '', body: '', stopOnReply: true });

export default function Following() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, pages: 0 });
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [modal, setModal] = useState({ open: false, mode: 'create', id: null });
  const [form, setForm] = useState(emptyForm());
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [imports, setImports] = useState([]);
  const [templates, setTemplates] = useState([]);

  const [confirm, setConfirm] = useState(null); // { type: 'single'|'all', following? }
  const [deleting, setDeleting] = useState(false);

  // Recipient inspector: per-recipient send state, including recipients that
  // were skipped because the contact replied or opted out (Phase 1).
  const [recipientsModal, setRecipientsModal] = useState(null); // { name, rows } | null
  const [recipientsLoading, setRecipientsLoading] = useState(false);

  // Contact selection (scoped to the chosen import), same model as Enrollments:
  //  - individual: `selectedIds`; or selectAll: everything EXCEPT `excludedIds`.
  const [contacts, setContacts] = useState([]);
  const [eligibleTotal, setEligibleTotal] = useState(0);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectAllMode, setSelectAllMode] = useState(false);
  const [excludedIds, setExcludedIds] = useState(() => new Set());
  const [contactSearch, setContactSearch] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);
  const selectAllRef = useRef(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/followings', {
        params: { status: statusFilter || undefined, page, limit: 20 },
      });
      setRows(data.data);
      setPagination(data.pagination);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load follow-ups');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  const loadImports = async () => {
    try {
      const { data } = await api.get('/contact-imports');
      setImports(data.data);
    } catch { setImports([]); }
  };
  const loadTemplates = async () => {
    try {
      // Phase 7: options endpoint so >100 templates all appear in the picker.
      const { data } = await api.get('/templates/options');
      setTemplates(data.data);
    } catch { setTemplates([]); }
  };

  // ---- contact selection helpers ----
  const clearSelection = useCallback(() => {
    setSelectAllMode(false);
    setSelectedIds(new Set());
    setExcludedIds(new Set());
  }, []);

  const fetchEligible = useCallback(async (importId, search) => {
    if (!importId) { setContacts([]); setEligibleTotal(0); return; }
    setContactsLoading(true);
    try {
      const { data } = await api.get('/contacts', {
        params: {
          import: importId,
          search: search || undefined,
          // Opted-out contacts are never eligible for a follow-up (Phase 1);
          // the backend re-validates this on save regardless.
          optedOut: 'false',
          limit: LIST_LIMIT,
        },
      });
      setContacts(data.data);
      if (!search) setEligibleTotal(data.pagination?.total ?? data.data.length);
    } catch (err) {
      setFormError(err.response?.data?.message || 'Failed to load contacts');
      setContacts([]);
    } finally {
      setContactsLoading(false);
    }
  }, []);

  // Debounced search within the selected import's contacts.
  useEffect(() => {
    if (!modal.open || !form.importId) return undefined;
    const t = setTimeout(() => fetchEligible(form.importId, contactSearch), 300);
    return () => clearTimeout(t);
  }, [contactSearch, form.importId, modal.open, fetchEligible]);

  useEffect(() => {
    if (!dropdownOpen) return undefined;
    const onDown = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setDropdownOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [dropdownOpen]);

  const selectedCount = selectAllMode ? Math.max(eligibleTotal - excludedIds.size, 0) : selectedIds.size;
  const isAllSelected = selectAllMode && excludedIds.size === 0;
  const isChecked = (id) => (selectAllMode ? !excludedIds.has(id) : selectedIds.has(id));

  const toggleContact = (id) => {
    if (selectAllMode) {
      setExcludedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
    } else {
      setSelectedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
    }
  };
  const toggleSelectAll = () => {
    if (isAllSelected) clearSelection();
    else { setSelectAllMode(true); setExcludedIds(new Set()); setSelectedIds(new Set()); }
  };
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectedCount > 0 && !isAllSelected;
  });

  const onImportChange = (importId) => {
    setForm((f) => ({ ...f, importId }));
    clearSelection();
    setContactSearch('');
    setDropdownOpen(false);
    fetchEligible(importId, '');
  };

  // ---- open create / edit ----
  const openCreate = () => {
    setForm(emptyForm());
    clearSelection();
    setContacts([]); setEligibleTotal(0); setContactSearch('');
    setFormError('');
    loadImports(); loadTemplates();
    setModal({ open: true, mode: 'create', id: null });
  };

  const openEdit = async (row) => {
    setFormError('');
    loadImports(); loadTemplates();
    setModal({ open: true, mode: 'edit', id: row._id });
    try {
      const { data } = await api.get(`/followings/${row._id}`);
      const f = data.data;
      const importId = f.import?._id || f.import || '';
      setForm({
        name: f.name || '',
        importId,
        delayValue: f.delayValue,
        delayUnit: f.delayUnit,
        templateId: f.template?._id || f.template || '',
        body: f.template ? '' : (f.body || ''),
        // Legacy records have no stopOnReply; the default is on.
        stopOnReply: f.stopOnReply !== false,
      });
      // Preselect the record's existing contacts explicitly.
      clearSelection();
      setSelectedIds(new Set((f.contactIds || []).map(String)));
      setContactSearch('');
      fetchEligible(importId, '');
    } catch (err) {
      setFormError(err.response?.data?.message || 'Failed to load follow-up');
    }
  };

  const closeModal = () => { setModal({ open: false, mode: 'create', id: null }); setDropdownOpen(false); };

  const selectedTemplate = templates.find((t) => t._id === form.templateId);
  // Phase 7: the picker list carries id + name only, so the chosen template's
  // body is fetched on demand rather than downloading every body up front.
  const [selectedTemplateBody, setSelectedTemplateBody] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (!form.templateId) { setSelectedTemplateBody(null); return undefined; }
    setSelectedTemplateBody(null);
    (async () => {
      try {
        const { data } = await api.get(`/templates/${form.templateId}`);
        if (!cancelled) setSelectedTemplateBody(data.data.body);
      } catch {
        if (!cancelled) setSelectedTemplateBody('');
      }
    })();
    return () => { cancelled = true; };
  }, [form.templateId]);

  const buildContactPayload = () =>
    selectAllMode
      ? { selectAll: true, excludeContactIds: [...excludedIds] }
      : { contactIds: [...selectedIds] };

  const saveFollowing = async (e) => {
    e.preventDefault();
    setFormError('');
    if (!form.name.trim()) { setFormError('Following name is required'); return; }
    if (!form.importId) { setFormError('Select a contact list (CSV import)'); return; }
    if (selectedCount === 0) { setFormError('Select at least one contact'); return; }
    if (!form.templateId && !form.body.trim()) { setFormError('Choose a template or enter a custom message'); return; }

    const message = form.templateId ? { templateId: form.templateId } : { body: form.body };
    const payload = {
      name: form.name.trim(),
      importId: form.importId,
      delayValue: Number(form.delayValue) || 0,
      delayUnit: form.delayUnit,
      stopOnReply: !!form.stopOnReply,
      ...message,
      ...buildContactPayload(),
    };

    setSaving(true);
    try {
      if (modal.mode === 'create') {
        await api.post('/followings', payload);
        setNotice('Follow-up created as a draft. Activate it to start sending.');
      } else {
        await api.put(`/followings/${modal.id}`, payload);
        setNotice('Follow-up updated.');
      }
      closeModal();
      fetchRows();
    } catch (err) {
      setFormError(err.response?.data?.message || 'Failed to save follow-up');
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (row, status) => {
    setError(''); setNotice('');
    try {
      await api.patch(`/followings/${row._id}`, { status });
      setNotice(status === 'active' ? 'Follow-up activated.' : 'Follow-up paused.');
      fetchRows();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to update status');
    }
  };

  // Load one follow-up's recipients (the list endpoint omits them to stay light).
  const openRecipients = async (row) => {
    setError('');
    setRecipientsLoading(true);
    setRecipientsModal({ name: row.name, rows: [] });
    try {
      const { data } = await api.get(`/followings/${row._id}`);
      setRecipientsModal({ name: row.name, rows: data.data.recipients || [] });
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load recipients');
      setRecipientsModal(null);
    } finally {
      setRecipientsLoading(false);
    }
  };

  // Turn a stored reason code into something an operator can read.
  const reasonLabel = (r) => {
    if (!r) return '';
    if (r === 'replied') return 'contact replied';
    if (r === 'opted_out') return 'contact opted out';
    if (r === 'inactive') return 'contact inactive';
    if (r === 'invalid_number') return 'invalid number';
    return r;
  };

  const deleteOne = (row) => { setError(''); setNotice(''); setConfirm({ type: 'single', following: row }); };
  const deleteAll = () => { setError(''); setNotice(''); setConfirm({ type: 'all' }); };

  const performDelete = async () => {
    if (!confirm) return;
    setDeleting(true);
    setError('');
    try {
      if (confirm.type === 'single') {
        await api.delete(`/followings/${confirm.following._id}`);
        setNotice('Follow-up deleted. Contacts, CSV, campaigns and message history were kept.');
      } else {
        const { data } = await api.delete('/followings');
        setNotice(`Deleted ${data.deletedCount} follow-up${data.deletedCount === 1 ? '' : 's'}.`);
        setPage(1);
      }
      setConfirm(null);
      fetchRows();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to delete. Please try again.');
      setConfirm(null);
    } finally {
      setDeleting(false);
    }
  };

  const fmt = (d) => (d ? new Date(d).toLocaleString() : '—');
  const chipClass = (s) =>
    s === 'active' ? 'chip chip-on' : s === 'completed' ? 'chip' : s === 'paused' ? 'chip chip-warn' : 'chip';

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Following</h1>
          <div className="page-sub">Automated follow-up messages sent after a delay.</div>
        </div>
        <div className="head-actions">
          <button className="btn btn-primary" onClick={openCreate}>+ New follow-up</button>
          {/* Phase 0: destructive bulk action is admin-only (server enforces it too). */}
          {isAdmin && (
            <button className="btn btn-danger" onClick={deleteAll} disabled={pagination.total === 0}>Delete All</button>
          )}
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-info">{notice}</div>}

      <div className="filters">
        <select className="input" value={statusFilter} onChange={(e) => { setPage(1); setStatusFilter(e.target.value); }}>
          <option value="">All statuses</option>
          <option value="draft">draft</option>
          <option value="active">active</option>
          <option value="paused">paused</option>
          <option value="completed">completed</option>
        </select>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Contact list</th>
              <th>Contacts</th>
              <th>Timing</th>
              <th>Message</th>
              <th>Status</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8}><Spinner label="Loading follow-ups…" /></td></tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <EmptyState
                    icon={FollowingIcon}
                    title={statusFilter ? `No ${statusFilter} follow-ups` : 'No follow-ups yet'}
                    hint={statusFilter ? 'Try a different status filter.' : 'Create a follow-up to automatically message contacts after a delay.'}
                  />
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row._id}>
                  <td>{row.name}</td>
                  <td>{row.import?.filename || <span className="muted">(deleted list)</span>}</td>
                  <td>{row.contactIds?.length ?? 0}</td>
                  <td className="small">{row.delayValue} {row.delayUnit}</td>
                  <td className="small">
                    {row.template ? (
                      <span className="chip">{row.template.name || 'template'}</span>
                    ) : (
                      <span className="muted">Custom</span>
                    )}
                  </td>
                  <td><span className={chipClass(row.status)}>{row.status}</span></td>
                  <td className="small">{fmt(row.createdAt)}</td>
                  <td className="row-actions">
                    {(row.status === 'draft' || row.status === 'paused') && (
                      <button className="btn btn-sm" onClick={() => changeStatus(row, 'active')}>Activate</button>
                    )}
                    {row.status === 'active' && (
                      <button className="btn btn-sm" onClick={() => changeStatus(row, 'paused')}>Pause</button>
                    )}
                    <button className="btn btn-sm" onClick={() => openRecipients(row)}>Recipients</button>
                    <button className="btn btn-sm" onClick={() => openEdit(row)}>Edit</button>
                    <button className="btn btn-sm btn-danger" onClick={() => deleteOne(row)}>Delete</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</button>
        <span className="muted">Page {pagination.page} of {pagination.pages || 1} ({pagination.total} total)</span>
        <button className="btn btn-sm" disabled={page >= (pagination.pages || 1)} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>

      {modal.open && (
        <Modal wide title={modal.mode === 'create' ? 'New follow-up' : 'Edit follow-up'} onClose={closeModal}>
          <form onSubmit={saveFollowing}>
            {formError && <div className="alert alert-error">{formError}</div>}

            <label className="field">
              <span>Following name *</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Lead Follow Up" required />
            </label>

            <label className="field">
              <span>Contact source (CSV import) *</span>
              <select className="input" value={form.importId} onChange={(e) => onImportChange(e.target.value)} required>
                <option value="">Select imported CSV…</option>
                {imports.map((imp) => (
                  <option key={imp._id} value={imp._id}>
                    {imp.filename || 'import'} ({imp.contactCount} contacts)
                  </option>
                ))}
              </select>
            </label>

            {/* Contact multi-select (eligible contacts of the chosen import) */}
            <label className="field">
              <span>Contacts *</span>
              <div className="ms" ref={dropdownRef}>
                <button
                  type="button"
                  className="ms-btn"
                  onClick={() => setDropdownOpen((v) => !v)}
                  disabled={!form.importId}
                  aria-haspopup="listbox"
                  aria-expanded={dropdownOpen}
                >
                  <span className={selectedCount === 0 ? 'muted' : ''}>
                    {!form.importId
                      ? 'Select a contact list first'
                      : selectedCount === 0
                      ? 'Select contacts…'
                      : isAllSelected
                      ? `All ${eligibleTotal.toLocaleString()} selected`
                      : `${selectedCount.toLocaleString()} selected`}
                  </span>
                  <svg className="ms-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>

                {dropdownOpen && form.importId && (
                  <div className="ms-panel" role="listbox">
                    <input
                      className="input ms-search"
                      placeholder="Search name, phone or email…"
                      value={contactSearch}
                      onChange={(e) => setContactSearch(e.target.value)}
                      autoFocus
                    />
                    <label className="ms-opt ms-all">
                      <input ref={selectAllRef} type="checkbox" checked={isAllSelected} onChange={toggleSelectAll} disabled={eligibleTotal === 0} />
                      <span>Select all{eligibleTotal ? ` (${eligibleTotal.toLocaleString()})` : ' (0)'}</span>
                    </label>
                    {selectedCount > 0 && (
                      <label className="ms-opt">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={clearSelection}>Deselect all</button>
                      </label>
                    )}
                    <div className="ms-divider" />
                    <div className="ms-list">
                      {contactsLoading ? (
                        <div className="ms-empty"><Spinner label="Loading…" /></div>
                      ) : contacts.length === 0 ? (
                        <div className="ms-empty muted small">{contactSearch ? 'No matching contacts.' : 'No contacts in this list.'}</div>
                      ) : (
                        contacts.map((c) => {
                          // A number Twilio Lookup reported invalid cannot be
                          // added; the backend drops it regardless.
                          const invalidNumber = c.lookup?.status === 'invalid';
                          return (
                            <label className="ms-opt" key={c._id}>
                              <input type="checkbox" disabled={invalidNumber} checked={!invalidNumber && isChecked(String(c._id))} onChange={() => toggleContact(String(c._id))} />
                              <span className="ms-name">{c.name || c.phone}</span>
                              <span className="ms-phone muted small">{invalidNumber ? `${c.phone} · invalid number` : c.phone}</span>
                            </label>
                          );
                        })
                      )}
                    </div>
                    <div className="ms-foot">
                      <span className="muted small">
                        {selectedCount.toLocaleString()} selected
                        {eligibleTotal > contacts.length && !contactSearch ? ` · showing ${contacts.length} of ${eligibleTotal.toLocaleString()}` : ''}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </label>

            {/* Timing */}
            <div className="field">
              <span>Wait before sending *</span>
              <div className="step-delay">
                <input
                  type="number" min="0" className="input input-narrow"
                  value={form.delayValue}
                  onChange={(e) => setForm({ ...form, delayValue: e.target.value })}
                />
                <select className="input input-narrow" value={form.delayUnit} onChange={(e) => setForm({ ...form, delayUnit: e.target.value })}>
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                </select>
                <span className="muted small">from activation</span>
              </div>
            </div>

            {/* Phase 2: stop for contacts who reply */}
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={!!form.stopOnReply}
                onChange={(e) => setForm({ ...form, stopOnReply: e.target.checked })}
              />
              <span>
                Stop for contacts who reply
                <div className="muted small">
                  A contact who replies after this follow-up is activated is skipped instead of
                  messaged. Opted-out contacts are always skipped, whatever this is set to.
                </div>
              </span>
            </label>

            {/* Message: template or custom */}
            <label className="field">
              <span>Message template</span>
              <select className="input" value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })}>
                <option value="">No template / Custom message</option>
                {templates.map((t) => (<option key={t._id} value={t._id}>{t.name}</option>))}
              </select>
            </label>

            {form.templateId ? (
              <div className="field">
                <span>Template message</span>
                <div className="alert alert-info" style={{ whiteSpace: 'pre-wrap' }}>
                  {selectedTemplateBody !== null ? (selectedTemplateBody || '(template unavailable)') : 'Loading template…'}
                </div>
                <div className="muted small">Merge fields like {'{{first_name}}'} are filled in per contact when sent.</div>
              </div>
            ) : (
              <label className="field">
                <span>Message body *</span>
                <textarea
                  rows={3}
                  placeholder="Hi {{first_name}}, just checking in regarding our previous message."
                  value={form.body}
                  onChange={(e) => setForm({ ...form, body: e.target.value })}
                />
                <SmsCounter text={form.body} />
              </label>
            )}

            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={closeModal}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : modal.mode === 'create' ? 'Create follow-up' : 'Save changes'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {recipientsModal && (
        <Modal wide title={`Recipients — ${recipientsModal.name}`} onClose={() => setRecipientsModal(null)}>
          {recipientsLoading ? (
            <Spinner label="Loading recipients…" />
          ) : recipientsModal.rows.length === 0 ? (
            <p className="muted small">
              No recipients yet. The send list is built when the follow-up is activated.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Contact</th>
                    <th>Status</th>
                    <th>Reason</th>
                    <th>Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {recipientsModal.rows.map((r, i) => (
                    <tr key={r.contact?._id || i}>
                      <td>
                        {r.contact ? r.contact.name || r.contact.phone : <span className="muted">(deleted contact)</span>}
                        {r.contact?.phone && r.contact?.name && (
                          <div className="muted small">{r.contact.phone}</div>
                        )}
                      </td>
                      <td>
                        <span
                          className={
                            r.status === 'sent'
                              ? 'chip chip-on'
                              : r.status === 'failed'
                              ? 'chip chip-invalid'
                              : r.status === 'skipped'
                              ? 'chip chip-warn'
                              : 'chip'
                          }
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="small">
                        {r.status === 'skipped' && r.lastError ? (
                          reasonLabel(r.lastError)
                        ) : r.lastError ? (
                          r.lastError
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="small">{r.sentAt ? new Date(r.sentAt).toLocaleString() : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setRecipientsModal(null)}>
              Close
            </button>
          </div>
        </Modal>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.type === 'single' ? 'Delete follow-up?' : `Delete all ${pagination.total} follow-ups?`}
          confirmLabel={confirm.type === 'single' ? 'Delete' : 'Delete All'}
          busy={deleting}
          onConfirm={performDelete}
          onClose={() => setConfirm(null)}
          message={
            confirm.type === 'single' ? (
              <p>
                Delete <strong>{confirm.following.name}</strong> and stop its future sends? Contacts, CSV imports,
                campaigns, enrollments and message history are all kept. This cannot be undone.
              </p>
            ) : (
              <p>
                This will permanently delete <strong>all {pagination.total} follow-ups</strong> and stop their future
                sends. Contacts, CSV imports, campaigns and message history are kept. This cannot be undone.
              </p>
            )
          }
        />
      )}
    </div>
  );
}

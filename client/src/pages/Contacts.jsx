// Contact management screen: list with search/tag filter/pagination, plus
// create, edit, delete, and CSV/XLSX import.
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import ConfirmDialog from '../components/ConfirmDialog';
import ImportBatchPanel from '../components/ImportBatchPanel';
import {
  formatCount,
  fetchAllocation,
  batchQueryParam,
  selectableBatches,
  batchOptionLabel,
} from '../utils/importBatch';
import {
  LOOKUP_OPTIONS,
  lookupOptionLabel,
  lookupCountsLine,
  emptySelection,
  selectAllMatching,
  isChecked,
  toggleContact,
  selectedCount,
  bulkDeletePayload,
  deleteInvalidPayload,
  deleteSelectedMessage,
  deleteInvalidMessage,
  lookupProgress,
  fetchLookupSummary,
  requestLookupAll,
  fetchLookupAllStatus,
  requestBulkDelete,
  requestDeleteInvalid,
} from '../utils/contactLookup';

const emptyForm = { name: '', phone: '', email: '', tags: '', timezone: '' };

const ContactsIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

export default function Contacts() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [contacts, setContacts] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, pages: 0 });
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  // '' = all, 'true' = opted out only, 'false' = contactable only (Phase 1).
  const [optedOutFilter, setOptedOutFilter] = useState('');
  // '' = all, 'true' = delivery-blocked only (Phase 3).
  const [deliveryFilter, setDeliveryFilter] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [modal, setModal] = useState({ open: false, mode: 'create', id: null, contact: null });
  const [form, setForm] = useState(emptyForm);
  // Opt-out / opt-in confirmation (kept separate from the delete dialog).
  const [optOutConfirm, setOptOutConfirm] = useState(null); // { contact, next }
  const [optOutBusy, setOptOutBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(null); // { type: 'single'|'all', contact? }
  const [deleting, setDeleting] = useState(false);

  const [importFile, setImportFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState(null);
  // Phase 6 wizard: 1 = choose file, 2 = preview, 3 = result.
  const [importStep, setImportStep] = useState(1);
  const [preview, setPreview] = useState(null);
  const [importError, setImportError] = useState('');
  const [enrollCampaignId, setEnrollCampaignId] = useState('');
  const [campaignOptions, setCampaignOptions] = useState([]);
  const [dragOver, setDragOver] = useState(false);

  // Imported lists (CSV/XLSX batches). Always driven by the authoritative
  // /contact-imports endpoint so a deleted import never lingers here.
  const [imports, setImports] = useState([]);
  const [importsLoading, setImportsLoading] = useState(false);
  // The imported list whose batches are open in the Batches dialog.
  const [batchImport, setBatchImport] = useState(null);

  // Per-row Twilio Lookup state (contact id currently being looked up).
  const [lookingUpId, setLookingUpId] = useState(null);

  // Batch views of one imported list. The master contacts are never removed:
  // '' = every contact; with a list chosen, the view narrows it to that list's
  // current batch, its remaining pool, or one batch — resolved by the SERVER
  // from each contact's persisted batch marker.
  const [listFilter, setListFilter] = useState('');
  const [batchView, setBatchView] = useState('all'); // 'all' | 'current' | 'remaining' | <batchId>
  const [listAllocation, setListAllocation] = useState(null);
  const [batchViewInfo, setBatchViewInfo] = useState(null);
  // Bumped after an allocation so the table refetches even if the view is unchanged.
  const [contactsVersion, setContactsVersion] = useState(0);

  // Twilio Lookup result filter + real counts, Lookup All, and bulk selection.
  // Lookup result, delivery state and the sending policy are separate concepts:
  // this filter reads only Contact.lookup.
  const [lookupFilter, setLookupFilter] = useState('');
  const [lookupSummaryData, setLookupSummaryData] = useState(null);
  const [lookupJob, setLookupJob] = useState(null);
  const [lookupConfirm, setLookupConfirm] = useState(false);
  const [selection, setSelection] = useState(emptySelection);
  const [bulkConfirm, setBulkConfirm] = useState(null); // { type: 'selected'|'invalid', count }
  const [bulkBusy, setBulkBusy] = useState(false);

  // The current filters, exactly as the server reads them. The same object
  // drives the list, the lookup counts, Select All and the deletes.
  const filterParams = useMemo(() => ({
    search: search || undefined,
    tag: tag || undefined,
    optedOut: optedOutFilter || undefined,
    deliveryBlocked: deliveryFilter || undefined,
    import: listFilter || undefined,
    batch: listFilter ? batchQueryParam(batchView) : undefined,
    lookup: lookupFilter || undefined,
  }), [search, tag, optedOutFilter, deliveryFilter, listFilter, batchView, lookupFilter]);
  const filterKey = JSON.stringify(filterParams);

  // The table and the real per-bucket lookup counts (the lookup bucket itself
  // aside, plus how many in scope still need a lookup) are loaded TOGETHER, so
  // every path that refreshes the contacts — import, edit, delete, allocation,
  // Lookup All — refreshes the counts too.
  const fetchContacts = useCallback(async () => {
    setLoading(true);
    setError('');
    fetchLookupSummary(api, { ...filterParams, lookup: undefined })
      .then(setLookupSummaryData)
      .catch(() => setLookupSummaryData(null));
    try {
      const { data } = await api.get('/contacts', {
        params: { ...filterParams, page, limit: 20 },
      });
      setContacts(data.data);
      setPagination(data.pagination);
      setBatchViewInfo(data.batchView || null);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load contacts');
    } finally {
      setLoading(false);
    }
    // contactsVersion only forces a refetch after an allocation or delete.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, page, contactsVersion]);

  // Selection belongs to one set of filters: changing them clears it, so
  // "Select All" can never reach contacts the operator no longer sees.
  useEffect(() => { setSelection(emptySelection()); }, [filterKey]);

  // Lookup All runs on the server; show its progress while it runs (including
  // a run started from another tab), then refresh what it changed.
  useEffect(() => {
    fetchLookupAllStatus(api).then(setLookupJob).catch(() => {});
  }, []);
  const lookupRunning = lookupJob?.status === 'running';
  useEffect(() => {
    if (!lookupRunning) return undefined;
    const id = setInterval(() => {
      fetchLookupAllStatus(api)
        .then((job) => {
          setLookupJob(job);
          if (job.status !== 'running') {
            setContactsVersion((v) => v + 1);
            loadImports();
          }
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupRunning]);

  // Counts and batch numbers for the chosen list's views and Batch column.
  useEffect(() => {
    if (!listFilter) { setListAllocation(null); return undefined; }
    let cancelled = false;
    fetchAllocation(api, listFilter)
      .then((d) => { if (!cancelled) setListAllocation(d); })
      .catch(() => { if (!cancelled) setListAllocation(null); });
    return () => { cancelled = true; };
  }, [listFilter, contactsVersion]);

  const showList = (importId, view = 'all') => {
    setListFilter(importId ? String(importId) : '');
    setBatchView(view);
    setPage(1);
  };

  // After a batch is allocated (from any panel on this page): show that batch.
  const onBatchAllocated = (res) => {
    loadImports();
    showList(res.data.importId, 'current');
    setContactsVersion((v) => v + 1);
  };

  // The chosen batch, by name ("Batch 2"), for the buttons and the scope line.
  const scopeName = (() => {
    if (!listFilter || batchView === 'all') return '';
    if (batchView === 'remaining') return 'Remaining contacts';
    const id = batchView === 'current' ? listAllocation?.currentBatch?._id : batchView;
    const b = listAllocation?.batches.find((x) => String(x._id) === String(id));
    return b ? `Batch ${b.number}` : batchView === 'current' ? 'Current batch' : '';
  })();

  // "in Batch 2 " / "in this list " / "" — where Lookup All will look.
  const lookupScopePhrase = scopeName ? `in ${scopeName} ` : listFilter ? 'in this list ' : '';

  // Lookup All over the chosen list (or every contact). The server refuses a
  // second run while one is going, from any tab or server.
  const runLookupAll = async () => {
    setLookupConfirm(false);
    setError('');
    try {
      setLookupJob(await requestLookupAll(api, listFilter || undefined, listFilter ? batchQueryParam(batchView) : undefined));
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to start Lookup All');
      if (err.response?.data?.job) setLookupJob(err.response.data.job);
    }
  };

  // Delete Selected / Delete All Invalid. One request per confirmation.
  const bulkLock = useRef(false);
  const matchingTotal = pagination.total;
  const performBulkDelete = async () => {
    if (!bulkConfirm || bulkLock.current) return;
    bulkLock.current = true;
    setBulkBusy(true);
    setError('');
    setNotice('');
    try {
      const filters = Object.fromEntries(Object.entries(filterParams).filter(([, v]) => v !== undefined));
      const data = bulkConfirm.type === 'invalid'
        ? await requestDeleteInvalid(api, deleteInvalidPayload(filters, bulkConfirm.count))
        : await requestBulkDelete(api, bulkDeletePayload(selection, filters, matchingTotal));
      setNotice(
        `Deleted ${formatCount(data.deleted)} contact${data.deleted === 1 ? '' : 's'}`
          + (data.deletedEnrollments ? ` and ${formatCount(data.deletedEnrollments)} enrollment${data.deletedEnrollments === 1 ? '' : 's'}` : '')
          + '. Conversations and message history were kept.'
      );
      setSelection(emptySelection());
      // Stay on this page unless it no longer exists.
      const lastPage = Math.max(Math.ceil(Math.max(matchingTotal - data.deleted, 0) / 20), 1);
      if (page > lastPage) setPage(lastPage);
      setContactsVersion((v) => v + 1);
      loadImports();
    } catch (err) {
      setError(err.response?.data?.message || 'Delete failed');
    } finally {
      bulkLock.current = false;
      setBulkBusy(false);
      setBulkConfirm(null);
    }
  };

  // Debounce so typing in search/tag doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(fetchContacts, 300);
    return () => clearTimeout(t);
  }, [fetchContacts]);

  // Load the authoritative list of imports (with live contact counts).
  const loadImports = useCallback(async () => {
    setImportsLoading(true);
    try {
      const { data } = await api.get('/contact-imports');
      setImports(data.data);
    } catch {
      setImports([]);
    } finally {
      setImportsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadImports();
  }, [loadImports]);

  // Phase 6: campaigns offered by the "enroll after import" selector. Only
  // active campaigns with at least one step can actually receive enrollments.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get('/campaigns', { params: { limit: 100, isActive: true } });
        if (!cancelled) setCampaignOptions((data.data || []).filter((c) => (c.steps || []).length > 0));
      } catch {
        if (!cancelled) setCampaignOptions([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const openCreate = () => {
    setForm(emptyForm);
    setFormError('');
    setModal({ open: true, mode: 'create', id: null, contact: null });
  };

  const openEdit = (c) => {
    setForm({
      name: c.name || '',
      phone: c.phone || '',
      email: c.email || '',
      tags: (c.tags || []).join(', '),
      timezone: c.timezone || '',
    });
    setFormError('');
    setModal({ open: true, mode: 'edit', id: c._id, contact: c });
  };

  const closeModal = () => setModal({ open: false, mode: 'create', id: null, contact: null });

  // Manual opt-out / opt-in. Opting out also cancels the contact's active and
  // paused enrollments and skips their pending follow-ups (done server-side).
  const performOptOutToggle = async () => {
    if (!optOutConfirm) return;
    setOptOutBusy(true);
    setError('');
    try {
      const { data } = await api.patch(`/contacts/${optOutConfirm.contact._id}/opt-out`, {
        optedOut: optOutConfirm.next,
      });
      setNotice(
        optOutConfirm.next
          ? 'Contact opted out. Active enrollments were cancelled and pending follow-ups skipped.'
          : 'Contact opted back in. They were not re-enrolled into anything.'
      );
      // Keep the open modal in sync with the new state.
      setModal((m) => (m.open && m.id === data.data._id ? { ...m, contact: data.data } : m));
      setOptOutConfirm(null);
      fetchContacts();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to update opt-out status');
      setOptOutConfirm(null);
    } finally {
      setOptOutBusy(false);
    }
  };

  const saveContact = async (e) => {
    e.preventDefault();
    setSaving(true);
    setFormError('');
    const payload = {
      name: form.name,
      phone: form.phone,
      email: form.email,
      tags: form.tags,
      timezone: form.timezone,
    };
    try {
      if (modal.mode === 'create') {
        await api.post('/contacts', payload);
      } else {
        await api.put(`/contacts/${modal.id}`, payload);
      }
      closeModal();
      fetchContacts();
    } catch (err) {
      setFormError(err.response?.data?.message || 'Failed to save contact');
    } finally {
      setSaving(false);
    }
  };

  // Open the confirmation dialog (single or all). Actual deletion happens on
  // confirm, via the backend — never a per-row loop from the frontend.
  const deleteContact = (c) => { setError(''); setNotice(''); setConfirm({ type: 'single', contact: c }); };
  const deleteAll = () => { setError(''); setNotice(''); setConfirm({ type: 'all' }); };
  // Delete an imported list (CSV) record only — its contacts and history are kept.
  const deleteImport = (imp) => { setError(''); setNotice(''); setConfirm({ type: 'import', import: imp }); };

  const performDelete = async () => {
    if (!confirm) return;
    setDeleting(true);
    setError('');
    try {
      if (confirm.type === 'single') {
        await api.delete(`/contacts/${confirm.contact._id}`);
        setNotice('Contact deleted successfully.');
      } else if (confirm.type === 'import') {
        await api.delete(`/contact-imports/${confirm.import._id}`);
        setNotice('Imported list deleted. Its contacts and message history were kept.');
      } else {
        const { data } = await api.delete('/contacts');
        setNotice(`Deleted ${data.deletedCount} contact${data.deletedCount === 1 ? '' : 's'}.`);
        setPage(1);
      }
      setConfirm(null);
      fetchContacts();
      loadImports();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to delete. Please try again.');
      setConfirm(null);
    } finally {
      setDeleting(false);
    }
  };

  // Twilio Lookup for a single contact (force re-lookup so the UI reflects a
  // fresh result each click).
  const runLookup = async (c) => {
    setLookingUpId(c._id);
    setError('');
    try {
      await api.post(`/contacts/${c._id}/lookup?force=true`);
      fetchContacts();
    } catch (err) {
      setError(err.response?.data?.message || 'Lookup failed');
    } finally {
      setLookingUpId(null);
    }
  };

  // ---- Phase 6: import wizard (choose -> preview -> confirm) ---------------
  //
  // Step 2 calls /contacts/import/preview, which writes NOTHING. Step 3 sends
  // back only the previewToken — never the rows — so the server re-reads the
  // original upload and decides what is imported.
  const runPreview = async (e) => {
    if (e) e.preventDefault();
    if (!importFile) return;
    setImporting(true);
    setPreview(null);
    setImportSummary(null);
    setImportError('');
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', importFile);
      const { data } = await api.post('/contacts/import/preview', fd);
      setPreview(data);
      setImportStep(2);
    } catch (err) {
      setImportError(err.response?.data?.message || 'Could not read that file');
    } finally {
      setImporting(false);
    }
  };

  const runConfirm = async () => {
    if (!preview?.previewToken) return;
    setImporting(true);
    setImportError('');
    try {
      const { data } = await api.post('/contacts/import/confirm', {
        previewToken: preview.previewToken,
        enrollCampaignId: enrollCampaignId || undefined,
      });
      setImportSummary({ ...data.summary, enrollment: data.enrollment });
      setImportStep(3);
      setPreview(null);
      setImportFile(null);
      setPage(1);
      fetchContacts();
      loadImports();
    } catch (err) {
      setImportError(err.response?.data?.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const resetImport = () => {
    setImportStep(1);
    setPreview(null);
    setImportFile(null);
    setImportSummary(null);
    setImportError('');
    setEnrollCampaignId('');
  };

  // Sample CSV built from the SAME column names the parser accepts, so the
  // file can never drift from what the backend actually supports.
  const downloadSampleCsv = () => {
    const csv = [
      'name,phone,email,tags,timezone,opt_in_date,opt_in_source',
      'Jane Smith,+14155552671,jane@example.com,"vip,newsletter",America/New_York,2026-01-15,web form',
      'John Doe,4155552672,john@example.com,newsletter,,2026-02-01,in-store',
      'Minimal Row,14155552673,,,,,',
    ].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'webinfoys-contacts-sample.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Contacts</h1>
          <div className="page-sub">Manage your audience, import lists and verify numbers.</div>
        </div>
        <div className="head-actions">
          <button className="btn btn-primary" onClick={openCreate}>
            + Add contact
          </button>
          {/* Phase 0: destructive bulk action is admin-only. The server enforces
              this too (authorize('admin')); hiding the button is convenience, not
              the security boundary. */}
          {isAdmin && (
            <button className="btn btn-danger" onClick={deleteAll} disabled={pagination.total === 0}>
              Delete All
            </button>
          )}
        </div>
      </div>

      {notice && <div className="alert alert-info">{notice}</div>}

      {/* Phase 6: import wizard — choose, preview (no writes), confirm. */}
      <div className="card">
        <h3>
          Import contacts
          <span className="muted small" style={{ marginLeft: 8, fontWeight: 'normal' }}>
            Step {importStep} of 3
          </span>
        </h3>

        {importError && <div className="alert alert-error">{importError}</div>}

        {importStep === 1 && (
          <form onSubmit={runPreview}>
            <div
              className={dragOver ? 'alert alert-info' : 'alert'}
              style={{ border: '1px dashed var(--border, #444)', textAlign: 'center', padding: 16 }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer.files && e.dataTransfer.files[0];
                if (f) { setImportFile(f); setImportError(''); }
              }}
            >
              <div style={{ marginBottom: 8 }}>
                {importFile ? <strong>{importFile.name}</strong> : 'Drag a .csv or .xlsx file here, or choose one below.'}
              </div>
              <input
                type="file"
                accept=".csv,.xlsx"
                onChange={(e) => { setImportFile(e.target.files[0] || null); setImportError(''); }}
              />
            </div>
            <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={downloadSampleCsv}>
                Download sample CSV
              </button>
              <button className="btn btn-primary" type="submit" disabled={!importFile || importing}>
                {importing ? 'Reading…' : 'Preview import'}
              </button>
            </div>
            <div className="muted small">
              Preview only reads the file — nothing is saved until you confirm.
            </div>
          </form>
        )}

        {importStep === 2 && preview && (
          <div>
            <div className="muted small" style={{ marginBottom: 10 }}>
              <strong>{preview.filename}</strong> — nothing has been saved yet.
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              <span className="chip">{preview.summary.totalRows} rows</span>
              <span className="chip chip-on">{preview.summary.valid} will be imported</span>
              <span className="chip">
                {preview.summary.duplicatesInFile + preview.summary.duplicatesInDb} duplicate
                {preview.summary.duplicatesInFile + preview.summary.duplicatesInDb === 1 ? '' : 's'}
              </span>
              <span className={preview.summary.invalid > 0 ? 'chip chip-invalid' : 'chip'}>
                {preview.summary.invalid} invalid
              </span>
            </div>

            {preview.warnings?.length > 0 && (
              <details className="alert alert-info small">
                <summary>{preview.warnings.length} warning(s) — imported, with that value ignored</summary>
                <ul>
                  {preview.warnings.map((w, i) => <li key={i}>Row {w.row}: {w.reason}</li>)}
                </ul>
              </details>
            )}

            {preview.validSample.length > 0 && (
              <details open>
                <summary>
                  Will be imported ({preview.summary.valid})
                  {preview.validSampleTruncated && ` — showing the first ${preview.validSample.length}`}
                </summary>
                <div className="table-wrap" style={{ maxHeight: 260, overflow: 'auto' }}>
                  <table className="table">
                    <thead>
                      <tr><th>Row</th><th>Name</th><th>Phone</th><th>Email</th><th>Timezone</th></tr>
                    </thead>
                    <tbody>
                      {preview.validSample.map((r) => (
                        <tr key={r.row}>
                          <td className="small">{r.row}</td>
                          <td>{r.name || <span className="muted">—</span>}</td>
                          <td>{r.phone}</td>
                          <td className="small">{r.email || <span className="muted">—</span>}</td>
                          <td className="small">{r.timezone || <span className="muted">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}

            {preview.invalid.length > 0 && (
              <details open>
                <summary>Will NOT be imported ({preview.invalid.length})</summary>
                <div className="table-wrap" style={{ maxHeight: 260, overflow: 'auto' }}>
                  <table className="table">
                    <thead>
                      <tr><th>Row</th><th>Name</th><th>Phone</th><th>Reason</th></tr>
                    </thead>
                    <tbody>
                      {preview.invalid.map((r, i) => (
                        <tr key={`${r.row}-${i}`}>
                          <td className="small">{r.row}</td>
                          <td>{r.name || <span className="muted">—</span>}</td>
                          <td className="small">{r.phone || <span className="muted">—</span>}</td>
                          <td className="small">{r.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}

            <label className="field" style={{ marginTop: 12 }}>
              <span>Enroll imported contacts into a campaign (optional)</span>
              <select
                className="input"
                value={enrollCampaignId}
                onChange={(e) => setEnrollCampaignId(e.target.value)}
              >
                <option value="">Do not enroll</option>
                {campaignOptions.map((c) => (
                  <option key={c._id} value={c._id}>{c.name}</option>
                ))}
              </select>
              <span className="muted small">
                Enrolls <strong>every</strong> contact created by this import. Opted-out, inactive
                and delivery-blocked contacts are always skipped. To use the list in batches
                instead, leave this as &ldquo;Do not enroll&rdquo; and allocate a batch after the import.
              </span>
            </label>

            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={resetImport} disabled={importing}>
                Cancel
              </button>
              <button
                type="button" className="btn btn-primary" onClick={runConfirm}
                disabled={importing || preview.summary.valid === 0}
              >
                {importing ? 'Importing…' : `Import ${preview.summary.valid} contact${preview.summary.valid === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        )}

        {importStep === 3 && importSummary && (
          <div>
            <div className="alert alert-info">
              Imported <strong>{importSummary.created}</strong> of {importSummary.totalRows} rows.{' '}
              {importSummary.duplicatesInFile + importSummary.duplicatesInDb} duplicate(s),{' '}
              {importSummary.invalid} invalid.
              {importSummary.countsBalance === false && (
                <div className="muted small">Note: the row counts did not balance — check the details below.</div>
              )}
            </div>

            {importSummary.enrollment && (
              <div className="alert alert-info small">
                Enrollment: {importSummary.enrollment.enrolled} enrolled,{' '}
                {importSummary.enrollment.skipped} skipped,{' '}
                {importSummary.enrollment.notEligible} not eligible,{' '}
                {importSummary.enrollment.failed} failed.
                {importSummary.enrollment.errors?.length > 0 && (
                  <details>
                    <summary>Why</summary>
                    <ul>
                      {importSummary.enrollment.errors.map((er, i) => <li key={i}>{er.reason}</li>)}
                    </ul>
                  </details>
                )}
              </div>
            )}

            {importSummary.errors?.length > 0 && (
              <details open>
                <summary>{importSummary.errors.length} row(s) not imported</summary>
                <ul>
                  {importSummary.errors.map((er, i) => (
                    <li key={i}>{er.row ? `Row ${er.row}: ` : ''}{er.reason}</li>
                  ))}
                </ul>
              </details>
            )}

            {/* Batch allocation: use this list a batch at a time, without
                re-uploading. The state is persisted on the server. */}
            {importSummary.importId && importSummary.created > 0 && (
              <div className="batch-section">
                <h4>Use these contacts in batches</h4>
                <ImportBatchPanel
                  importId={importSummary.importId}
                  campaigns={campaignOptions}
                  showHistory={false}
                  onAllocated={onBatchAllocated}
                />
              </div>
            )}

            <div className="modal-actions">
              <button type="button" className="btn" onClick={resetImport}>Import another file</button>
            </div>
          </div>
        )}
      </div>

      {/* Imported lists (CSV/XLSX) — authoritative list; delete removes only the
          import record, never its contacts or history. */}
      <div className="card">
        <h3>Imported lists</h3>
        {importsLoading ? (
          <Spinner label="Loading imported lists…" />
        ) : imports.length === 0 ? (
          <p className="muted small">No imported lists yet. Upload a CSV / XLSX above to create one.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Contacts</th>
                  <th>Allocated</th>
                  <th>Remaining</th>
                  <th>Imported</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {imports.map((imp) => (
                  <tr key={imp._id}>
                    <td>{imp.filename || <span className="muted">—</span>}</td>
                    <td>{imp.contactCount}</td>
                    <td>{formatCount(imp.allocation?.allocated)}</td>
                    <td>{formatCount(imp.allocation?.remaining ?? imp.contactCount)}</td>
                    <td className="small">{new Date(imp.createdAt).toLocaleString()}</td>
                    <td className="row-actions">
                      <button className="btn btn-sm" onClick={() => showList(imp._id)}>
                        View
                      </button>
                      <button className="btn btn-sm" onClick={() => setBatchImport(imp)}>
                        Batches
                      </button>
                      {/* Phase 0: deleting an import record is admin-only; the
                          server enforces it with authorize('admin'). */}
                      {isAdmin ? (
                        <button className="btn btn-sm btn-danger" onClick={() => deleteImport(imp)}>
                          Delete
                        </button>
                      ) : (
                        <span className="muted small">Admin only</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="filters">
        <input
          className="input"
          placeholder="Search name, phone, or email…"
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch(e.target.value);
          }}
        />
        <input
          className="input"
          placeholder="Filter by tag"
          value={tag}
          onChange={(e) => {
            setPage(1);
            setTag(e.target.value);
          }}
        />
        <select
          className="input"
          style={{ maxWidth: 200 }}
          value={optedOutFilter}
          onChange={(e) => {
            setPage(1);
            setOptedOutFilter(e.target.value);
          }}
        >
          <option value="">All contacts</option>
          <option value="false">Active (not opted out)</option>
          <option value="true">Opted out</option>
        </select>
        <select
          className="input"
          style={{ maxWidth: 200 }}
          value={deliveryFilter}
          onChange={(e) => {
            setPage(1);
            setDeliveryFilter(e.target.value);
          }}
        >
          <option value="">Any delivery state</option>
          <option value="false">Deliverable</option>
          <option value="true">Delivery blocked</option>
        </select>
        <select
          className="input"
          style={{ maxWidth: 240 }}
          aria-label="Imported list"
          value={listFilter}
          onChange={(e) => showList(e.target.value)}
        >
          <option value="">All lists</option>
          {imports.map((imp) => (
            <option key={imp._id} value={imp._id}>{imp.filename || 'Untitled import'}</option>
          ))}
        </select>
        {/* CSV -> Batch: the batch is the unit of work. Every option is a real,
            persisted batch of THIS list; the server resolves its members. */}
        {listFilter && (
          <select
            className="input"
            style={{ maxWidth: 240 }}
            aria-label="Batch"
            value={batchView === 'current' ? String(listAllocation?.currentBatch?._id || 'current') : batchView}
            onChange={(e) => { setBatchView(e.target.value); setPage(1); }}
          >
            <option value="all">All contacts in this list{listAllocation ? ` (${formatCount(listAllocation.contacts ?? listAllocation.total)})` : ''}</option>
            {selectableBatches(listAllocation).map((b) => (
              <option key={b._id} value={String(b._id)}>{batchOptionLabel(b)}</option>
            ))}
            {batchView === 'current' && !listAllocation?.currentBatch && <option value="current">Current batch (none yet)</option>}
            <option value="remaining">Remaining{listAllocation ? ` — ${formatCount(listAllocation.remaining)} contacts` : ''}</option>
          </select>
        )}
        <select
          className="input"
          style={{ maxWidth: 220 }}
          aria-label="Lookup status"
          value={lookupFilter}
          onChange={(e) => {
            setPage(1);
            setLookupFilter(e.target.value);
          }}
        >
          {LOOKUP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.value ? '' : 'Lookup: '}{lookupOptionLabel(o, lookupSummaryData)}
            </option>
          ))}
        </select>
      </div>

      {/* Batch views of the chosen list. The master contacts are always kept;
          these only narrow what the table shows. */}
      {listFilter && (() => {
        const a = listAllocation;
        const current = a?.currentBatch;
        const isCurrentId = !!current && String(batchView) === String(current._id);
        const specific = !['all', 'current', 'remaining'].includes(batchView) && !isCurrentId
          ? a?.batches.find((b) => String(b._id) === String(batchView))
          : null;
        const activeKey = isCurrentId ? 'current' : batchView;
        const views = [
          { key: 'all', label: `All contacts${a ? ` (${formatCount(a.contacts ?? a.total)})` : ''}` },
          {
            key: 'current',
            label: current
              ? `Current batch — Batch ${current.number} (${formatCount(current.size)})`
              : 'Current batch (none yet)',
          },
          { key: 'remaining', label: `Remaining contacts${a ? ` (${formatCount(a.remaining)})` : ''}` },
        ];
        return (
          <div className="batch-view" role="group" aria-label="Batch view">
            <span className="muted small">View:</span>
            <div className="chip-row">
              {views.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  className={`btn btn-sm ${activeKey === v.key ? 'btn-primary' : ''}`}
                  aria-pressed={activeKey === v.key}
                  onClick={() => { setBatchView(v.key); setPage(1); }}
                >
                  {v.label}
                </button>
              ))}
              {specific && (
                <button type="button" className="btn btn-sm btn-primary" aria-pressed="true">
                  Batch {specific.number} ({formatCount(specific.size)})
                </button>
              )}
            </div>
            <span className="muted small">
              {batchView === 'all' && 'Every contact in this list, allocated or not.'}
              {activeKey === 'current' && (current
                ? `Only the contacts allocated in the latest batch (Batch ${current.number}).`
                : 'No batch has been allocated from this list yet.')}
              {batchView === 'remaining' && 'Contacts never allocated from this list — the pool for the next batch. Numbers Lookup reported invalid are excluded.'}
              {specific && `Only the contacts allocated in Batch ${specific.number}.`}
            </span>
          </div>
        );
      })()}

      {/* Twilio Lookup: run it, see the real counts, and clean up. */}
      <div className="lookup-bar">
        <div className="lookup-bar-row">
          {isAdmin && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setLookupConfirm(true)}
              disabled={lookupRunning || !lookupSummaryData || lookupSummaryData.needsLookup === 0}
              title={lookupSummaryData?.needsLookup === 0 ? 'Every number in scope has a current lookup' : undefined}
            >
              {lookupRunning ? 'Looking up…' : 'Lookup All'}
              {!lookupRunning && scopeName ? ` — ${scopeName}` : ''}
            </button>
          )}
          {lookupSummaryData && (
            <span className="muted small">
              {lookupSummaryData.needsLookup > 0
                ? `${formatCount(lookupSummaryData.needsLookup)} number${lookupSummaryData.needsLookup === 1 ? '' : 's'} ${lookupScopePhrase}need${lookupSummaryData.needsLookup === 1 ? 's' : ''} a lookup.`
                : `Every number ${lookupScopePhrase}has a current lookup.`}
            </span>
          )}
        </div>
        {(() => {
          const p = lookupProgress(lookupJob);
          if (!p) return null;
          return (
            <div className={`alert alert-${p.tone} small`} role="status" aria-live="polite">
              <div>
                {p.text}
                {p.running && (
                  <div className="progress" aria-hidden="true">
                    <div className="progress-fill" style={{ width: `${p.percent}%` }} />
                  </div>
                )}
              </div>
            </div>
          );
        })()}
        {lookupSummaryData && <div className="muted small lookup-counts">{lookupCountsLine(lookupSummaryData)}</div>}

        {/* Bulk selection — admin only, because deletion is. */}
        {isAdmin && (() => {
          const n = selectedCount(selection, matchingTotal);
          const invalidCount = lookupSummaryData?.counts?.invalid || 0;
          return (
            <div className="lookup-bar-row">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setSelection(selectAllMatching())}
                disabled={matchingTotal === 0 || bulkBusy}
              >
                Select All ({formatCount(matchingTotal)})
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setSelection(emptySelection())}
                disabled={n === 0 || bulkBusy}
              >
                Clear Selection
              </button>
              {n > 0 && <span className="small">{formatCount(n)} selected</span>}
              {n > 0 && (
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => setBulkConfirm({ type: 'selected', count: n })}
                  disabled={bulkBusy}
                >
                  Delete Selected
                </button>
              )}
              {lookupFilter === 'invalid' && invalidCount > 0 && (
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => setBulkConfirm({ type: 'invalid', count: invalidCount })}
                  disabled={bulkBusy}
                >
                  Delete {formatCount(invalidCount)} invalid contact{invalidCount === 1 ? '' : 's'}
                </button>
              )}
            </div>
          );
        })()}
      </div>

      {listFilter && (
        <div className="muted small scope-line" aria-live="polite">
          Showing {formatCount(pagination.total)} contact{pagination.total === 1 ? '' : 's'}
          {' · '}List: <strong>{imports.find((i) => String(i._id) === listFilter)?.filename || 'imported list'}</strong>
          {' · '}Batch: <strong>{scopeName || 'All contacts in this list'}</strong>
          {' · '}Lookup: <strong>{(LOOKUP_OPTIONS.find((o) => o.value === lookupFilter) || LOOKUP_OPTIONS[0]).label}</strong>
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      {/* Table */}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {isAdmin && <th aria-label="Select" />}
              <th>Name</th>
              <th>Phone</th>
              <th>Email</th>
              <th>Number</th>
              <th>Tags</th>
              <th>Custom fields</th>
              {listFilter && <th>Batch</th>}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={(listFilter ? 8 : 7) + (isAdmin ? 1 : 0)}>
                  <Spinner label="Loading contacts…" />
                </td>
              </tr>
            ) : contacts.length === 0 ? (
              <tr>
                <td colSpan={(listFilter ? 8 : 7) + (isAdmin ? 1 : 0)}>
                  <EmptyState
                    icon={ContactsIcon}
                    title={search || tag || optedOutFilter || deliveryFilter || listFilter || lookupFilter ? 'No matching contacts' : 'No contacts yet'}
                    hint={
                      listFilter && batchView === 'current' && !batchViewInfo?.batch
                        ? 'No batch has been allocated from this list yet.'
                        : listFilter && batchView === 'remaining'
                          ? 'Every contact in this list has been allocated.'
                          : search || tag || optedOutFilter || deliveryFilter || listFilter || lookupFilter
                            ? 'Try a different search, tag, opt-out, delivery, list or lookup filter.'
                            : 'Add a contact or import a CSV / XLSX file to get started.'
                    }
                  />
                </td>
              </tr>
            ) : (
              contacts.map((c) => (
                <tr key={c._id}>
                  {isAdmin && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${c.name || c.phone}`}
                        checked={isChecked(selection, c._id)}
                        onChange={() => setSelection((s) => toggleContact(s, c._id))}
                        disabled={bulkBusy}
                      />
                    </td>
                  )}
                  <td>
                    {c.name || <span className="muted">—</span>}
                    {c.optedOut && (
                      <span className="chip chip-invalid" style={{ marginLeft: 6 }}>
                        Opted out
                      </span>
                    )}
                    {c.deliveryBlocked && (
                      <span className="chip chip-warn" style={{ marginLeft: 6 }}>
                        Delivery blocked
                      </span>
                    )}
                  </td>
                  <td>{c.phone}</td>
                  <td>{c.email || <span className="muted">—</span>}</td>
                  <td className="small">
                    {lookingUpId === c._id ? (
                      <span className="muted">Looking up…</span>
                    ) : c.lookup && c.lookup.status && c.lookup.status !== 'unknown' ? (
                      c.lookup.status === 'invalid' ? (
                        <span className="chip chip-invalid">invalid</span>
                      ) : (
                        <span className="chip chip-on">
                          {c.lookup.type || 'valid'}
                          {c.lookup.carrier ? ` · ${c.lookup.carrier}` : ''}
                        </span>
                      )
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    {(c.tags || []).map((t) => (
                      <span key={t} className="chip">
                        {t}
                      </span>
                    ))}
                  </td>
                  <td className="mono small">
                    {c.customFields && Object.keys(c.customFields).length > 0
                      ? Object.entries(c.customFields)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(', ')
                      : ''}
                  </td>
                  {listFilter && (
                    <td>
                      {(() => {
                        // From the contact's own persisted batch marker.
                        if (!c.importBatch) return <span className="chip">Remaining</span>;
                        const b = listAllocation?.batches.find((x) => String(x._id) === String(c.importBatch));
                        const isCurrent = listAllocation?.currentBatch
                          && String(listAllocation.currentBatch._id) === String(c.importBatch);
                        return (
                          <span className={`chip${isCurrent ? ' chip-on' : ''}`}>
                            {b ? `Batch ${b.number}${b.status === 'deleted' ? ' (deleted)' : ''}` : 'Allocated'}
                          </span>
                        );
                      })()}
                    </td>
                  )}
                  <td className="row-actions">
                    <button
                      className="btn btn-sm"
                      onClick={() => runLookup(c)}
                      disabled={lookingUpId === c._id}
                    >
                      Lookup
                    </button>
                    <button className="btn btn-sm" onClick={() => openEdit(c)}>
                      Edit
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => deleteContact(c)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="pagination">
        <button
          className="btn btn-sm"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          Prev
        </button>
        <span className="muted">
          Page {pagination.page} of {pagination.pages || 1} ({pagination.total} total)
        </span>
        <button
          className="btn btn-sm"
          disabled={page >= (pagination.pages || 1)}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </div>

      {/* Create / Edit modal */}
      {modal.open && (
        <Modal
          title={modal.mode === 'create' ? 'Add contact' : 'Edit contact'}
          onClose={closeModal}
        >
          <form onSubmit={saveContact}>
            {formError && <div className="alert alert-error">{formError}</div>}
            <label className="field">
              <span>Name</span>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Phone *</span>
              <input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="+14155552671"
                required
              />
            </label>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Tags (comma-separated)</span>
              <input
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
                placeholder="vip, lead"
              />
            </label>
            {/* Phase 2: optional per-contact timezone, so automation can send
                inside this person's local hours. */}
            <label className="field">
              <span>Timezone (optional)</span>
              <input
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                placeholder="America/New_York"
              />
              <div className="muted small">
                IANA name. Leave blank to use the global sending window. Imported US numbers get
                this filled in automatically from their area code.
              </div>
            </label>
            {/* Opt-out state + toggle (Phase 1). Edit mode only — a brand new
                contact has no opt-out history yet. */}
            {modal.mode === 'edit' && modal.contact && (
              <div className="field">
                <span>SMS consent</span>
                {modal.contact.optedOut ? (
                  <div className="alert alert-error">
                    {/* .alert is a flex row, so the whole message stays in one
                        child element to keep it on a single text flow. */}
                    <div>
                      This contact has <strong>opted out</strong> and cannot be messaged.
                      {modal.contact.optedOutAt && (
                        <div className="muted small">
                          Opted out {new Date(modal.contact.optedOutAt).toLocaleString()}
                          {modal.contact.optOutSource ? ` · via ${modal.contact.optOutSource}` : ''}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="muted small">
                    This contact can receive messages.
                    {modal.contact.optedInAt && (
                      <> Opted back in {new Date(modal.contact.optedInAt).toLocaleString()}.</>
                    )}
                  </div>
                )}
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className={modal.contact.optedOut ? 'btn btn-sm' : 'btn btn-sm btn-danger'}
                    onClick={() =>
                      setOptOutConfirm({ contact: modal.contact, next: !modal.contact.optedOut })
                    }
                  >
                    {modal.contact.optedOut ? 'Opt back in' : 'Mark as opted out'}
                  </button>
                </div>
              </div>
            )}

            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={closeModal}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {optOutConfirm && (
        <ConfirmDialog
          title={optOutConfirm.next ? 'Mark contact as opted out?' : 'Opt this contact back in?'}
          confirmLabel={optOutConfirm.next ? 'Opt out' : 'Opt in'}
          danger={optOutConfirm.next}
          busy={optOutBusy}
          onConfirm={performOptOutToggle}
          onClose={() => setOptOutConfirm(null)}
          message={
            optOutConfirm.next ? (
              <p>
                <strong>{optOutConfirm.contact.name || optOutConfirm.contact.phone}</strong> will no
                longer receive any SMS — campaigns, follow-ups, manual sends and inbox replies are
                all blocked. Their active and paused enrollments are cancelled and pending follow-ups
                skipped. Contacts and message history are kept.
              </p>
            ) : (
              <p>
                <strong>{optOutConfirm.contact.name || optOutConfirm.contact.phone}</strong> will be
                able to receive SMS again. They are <strong>not</strong> re-enrolled into anything
                automatically — enroll them again if that is what you want.
              </p>
            )
          }
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={
            confirm.type === 'single'
              ? 'Delete contact?'
              : confirm.type === 'import'
              ? 'Delete imported list?'
              : `Delete all ${pagination.total} contacts?`
          }
          confirmLabel={confirm.type === 'all' ? 'Delete All' : 'Delete'}
          busy={deleting}
          onConfirm={performDelete}
          onClose={() => setConfirm(null)}
          message={
            confirm.type === 'single' ? (
              <p>
                Permanently delete <strong>{confirm.contact.name || confirm.contact.phone}</strong>? Their
                enrollments are removed too; message history is kept. This cannot be undone.
              </p>
            ) : confirm.type === 'import' ? (
              <p>
                Remove the imported list{' '}
                <strong>{confirm.import.filename || 'this import'}</strong> from the list? This deletes only the
                import record. The {confirm.import.contactCount} contact
                {confirm.import.contactCount === 1 ? '' : 's'} it added — along with campaigns, enrollments and
                message history — are kept.
              </p>
            ) : (
              <p>
                This will permanently delete <strong>all {pagination.total} contacts</strong> and their
                enrollment records. Campaigns and message history are kept. This action cannot be undone.
              </p>
            )
          }
        />
      )}

      {lookupConfirm && (
        <ConfirmDialog
          title="Look up numbers?"
          confirmLabel="Lookup All"
          danger={false}
          onConfirm={runLookupAll}
          onClose={() => setLookupConfirm(false)}
          message={
            <p>
              Check {formatCount(lookupSummaryData?.needsLookup)} number
              {lookupSummaryData?.needsLookup === 1 ? '' : 's'} {lookupScopePhrase}with
              Twilio Lookup. Numbers with a current lookup are skipped. Twilio Lookup is billed per
              number.
            </p>
          }
        />
      )}

      {bulkConfirm && (
        <ConfirmDialog
          title={bulkConfirm.type === 'invalid' ? 'Delete invalid contacts?' : 'Delete selected contacts?'}
          confirmLabel={bulkConfirm.type === 'invalid' ? 'Delete All Invalid' : 'Delete Selected'}
          busy={bulkBusy}
          onConfirm={performBulkDelete}
          onClose={() => { if (!bulkBusy) setBulkConfirm(null); }}
          message={
            <>
              <p>
                <strong>
                  {bulkConfirm.type === 'invalid'
                    ? deleteInvalidMessage(bulkConfirm.count)
                    : deleteSelectedMessage(bulkConfirm.count)}
                </strong>
              </p>
              <p className="muted small">
                {bulkConfirm.type === 'invalid'
                  ? 'Only numbers Twilio Lookup reported invalid are deleted — never unknown, unchecked, failed, landline or VoIP numbers. '
                  : ''}
                Their enrollments are removed with them. Conversations, message history, campaigns and
                follow-ups are kept, and imported-list counts are updated.
              </p>
            </>
          }
        />
      )}

      {batchImport && (
        <Modal
          title={`Batches — ${batchImport.filename || 'imported list'}`}
          onClose={() => setBatchImport(null)}
          wide
        >
          <ImportBatchPanel
            importId={batchImport._id}
            campaigns={campaignOptions}
            onAllocated={onBatchAllocated}
            onViewBatch={(b) => {
              showList(batchImport._id, b._id);
              setBatchImport(null);
            }}
            canDeleteBatches={isAdmin}
            onBatchDeleted={(res) => {
              loadImports();
              // A deleted batch can no longer be the scope of this page.
              if (listFilter === String(batchImport._id) && batchView !== 'all' && batchView !== 'remaining') {
                showList(batchImport._id, 'all');
              }
              setContactsVersion((v) => v + 1);
              setNotice(res.message);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

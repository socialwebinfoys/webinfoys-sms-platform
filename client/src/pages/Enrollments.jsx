// Enrollments screen: enroll contacts into campaigns and monitor/manage their
// progress through the automation engine.
//
// The contact selector is scoped to the SELECTED campaign's contact list (CSV
// import) and only shows ELIGIBLE contacts — members of that import that are not
// already enrolled. "Select all" enrolls all eligible contacts in one bulk
// request (backend resolves them by import, so it scales to thousands and never
// sends one request per contact). Changing the campaign clears the selection.
import { useEffect, useState, useCallback, useRef } from 'react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import ConfirmDialog from '../components/ConfirmDialog';
import ImportBatchPanel from '../components/ImportBatchPanel';
import { batchOptionLabel, NO_BATCHES_MESSAGE } from '../utils/importBatch';

const EnrollIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
  </svg>
);

// How many eligible contacts to load into the dropdown list at once. "Select
// all" still covers ALL eligible contacts via the backend, not just these.
const LIST_LIMIT = 100;

export default function Enrollments() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, pages: 0 });
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [campaigns, setCampaigns] = useState([]);
  const [campaignId, setCampaignId] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [confirm, setConfirm] = useState(null); // { type: 'single'|'all', enrollment? }
  const [deleting, setDeleting] = useState(false);

  // "Run automation now" dialog (Phase 2).
  const [runDialog, setRunDialog] = useState(false);
  const [respectWindow, setRespectWindow] = useState(true);
  const [running, setRunning] = useState(false);

  // Eligible-contacts state (scoped to the selected campaign's import).
  const [contacts, setContacts] = useState([]); // displayed (search-filtered) list
  const [eligibleTotal, setEligibleTotal] = useState(0); // total eligible (unfiltered)
  const [noImport, setNoImport] = useState(false); // campaign has no contact list
  // CSV -> Batch. The SERVER decides the scope (the campaign's own batch, or
  // the batch chosen here); the picker only ever lists that batch's contacts.
  const [enrollBatch, setEnrollBatch] = useState('');
  const [scope, setScope] = useState(null); // { import, batch, batches, fixed }
  const [requiresBatch, setRequiresBatch] = useState(false);
  const [contactsLoading, setContactsLoading] = useState(false);

  // Multi-select state (two mutually-exclusive modes):
  //  - individual: `selectedIds` holds the checked contact ids.
  //  - selectAll:  every eligible contact EXCEPT those in `excludedIds`.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectAllMode, setSelectAllMode] = useState(false);
  const [excludedIds, setExcludedIds] = useState(() => new Set());
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const dropdownRef = useRef(null);
  const triggerRef = useRef(null);
  const selectAllRef = useRef(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/enrollments', {
        params: { status: statusFilter || undefined, page, limit: 20 },
      });
      setRows(data.data);
      setPagination(data.pagination);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load enrollments');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  useEffect(() => {
    api.get('/campaigns', { params: { limit: 100 } }).then(({ data }) => setCampaigns(data.data)).catch(() => {});
  }, []);

  // Load eligible contacts for a campaign. When `search` is empty we also refresh
  // the (unfiltered) eligible total used for the "Select all (N)" label + count.
  const fetchEligible = useCallback(async (cid, search, batch) => {
    if (!cid) {
      setContacts([]); setEligibleTotal(0); setNoImport(false); setScope(null); setRequiresBatch(false);
      return;
    }
    setContactsLoading(true);
    try {
      const { data } = await api.get(`/campaigns/${cid}/eligible-contacts`, {
        params: { search: search || undefined, limit: LIST_LIMIT, batch: batch || undefined },
      });
      setContacts(data.data);
      setNoImport(!!data.noImport);
      setScope(data.scope || null);
      setRequiresBatch(!!data.requiresBatch);
      if (!search) setEligibleTotal(data.pagination?.total ?? data.data.length);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load contacts');
      setContacts([]);
      setEligibleTotal(0);
    } finally {
      setContactsLoading(false);
    }
  }, []);

  const clearSelection = useCallback(() => {
    setSelectAllMode(false);
    setSelectedIds(new Set());
    setExcludedIds(new Set());
  }, []);

  // Campaign change: clear the previous selection and load the new campaign's
  // eligible contacts (never carry contacts across campaigns).
  const onCampaignChange = (cid) => {
    setCampaignId(cid);
    setEnrollBatch('');
    clearSelection();
    setContactSearch('');
    setDropdownOpen(false);
    fetchEligible(cid, '', '');
  };

  // Batch change: a different set of contacts, so the selection starts over.
  const onBatchChange = (bid) => {
    setEnrollBatch(bid);
    clearSelection();
    setContactSearch('');
    setDropdownOpen(false);
    fetchEligible(campaignId, '', bid);
  };

  // Debounced backend search within the selected campaign's eligible contacts.
  useEffect(() => {
    if (!campaignId) return undefined;
    const t = setTimeout(() => fetchEligible(campaignId, contactSearch, enrollBatch), 300);
    return () => clearTimeout(t);
  }, [contactSearch, campaignId, enrollBatch, fetchEligible]);

  // Close the dropdown when clicking outside it.
  useEffect(() => {
    if (!dropdownOpen) return undefined;
    const onDown = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setDropdownOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [dropdownOpen]);

  // Open the dropdown, deciding whether to open upward when there's little room
  // below (keeps the panel within the viewport and off the table).
  const openDropdown = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom;
      const above = rect.top;
      setDropUp(below < 340 && above > below);
    }
    setDropdownOpen((v) => !v);
  };

  // ---- selection helpers ----
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

  const buttonLabel = () => {
    if (!campaignId) return 'Select a campaign first';
    if (noImport) return 'No contact list on this campaign';
    if (requiresBatch) return 'Select a batch first';
    if (selectedCount === 0) return 'Select contacts…';
    if (isAllSelected) return 'All eligible selected';
    if (!selectAllMode && selectedCount === 1) {
      const only = contacts.find((c) => selectedIds.has(c._id));
      if (only) return only.name || only.phone;
    }
    return `${selectedCount.toLocaleString()} contacts selected`;
  };

  const enroll = async (e) => {
    e.preventDefault();
    if (!campaignId || selectedCount === 0) return;
    setEnrolling(true);
    setError('');
    setNotice('');
    try {
      // The batch goes with the request; the server re-checks that every
      // contact belongs to it and refuses the whole request otherwise.
      const batchPart = !scope?.fixed && enrollBatch ? { batchId: enrollBatch } : {};
      const payload = selectAllMode
        ? { campaignId, selectAll: true, excludeContactIds: [...excludedIds], ...batchPart }
        : { campaignId, contactIds: [...selectedIds], ...batchPart };
      const { data } = await api.post('/enrollments', payload);
      const s = data.summary;
      const parts = [`Enrolled ${s.enrolled}`, `skipped ${s.skipped}`];
      if (s.notEligible) parts.push(`not eligible ${s.notEligible}`);
      if (s.notFound) parts.push(`not found ${s.notFound}`);
      if (s.failed) parts.push(`failed ${s.failed}`);
      setNotice(`${parts.join(', ')} (of ${s.total} requested).`);
      clearSelection();
      setContactSearch('');
      setDropdownOpen(false);
      fetchEligible(campaignId, '', enrollBatch);
      fetchRows();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to enroll');
    } finally {
      setEnrolling(false);
    }
  };

  const changeStatus = async (row, status) => {
    try {
      await api.patch(`/enrollments/${row._id}`, { status });
      fetchRows();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to update');
    }
  };

  // Deletion (single + filter-aware Delete All). Deleting an enrollment removes
  // ONLY the enrollment record; contact, campaign, conversation and SMS history
  // remain. The cron worker only queries live active enrollments, so a deleted
  // row is simply never processed again.
  const deleteEnrollment = (row) => { setError(''); setNotice(''); setConfirm({ type: 'single', enrollment: row }); };
  const deleteAll = () => { setError(''); setNotice(''); setConfirm({ type: 'all' }); };

  const performDelete = async () => {
    if (!confirm) return;
    setDeleting(true);
    setError('');
    try {
      if (confirm.type === 'single') {
        await api.delete(`/enrollments/${confirm.enrollment._id}`);
        setNotice('Enrollment deleted successfully.');
      } else {
        const { data } = await api.delete('/enrollments', { params: { status: statusFilter || undefined } });
        setNotice(`Deleted ${data.deletedCount} enrollment${data.deletedCount === 1 ? '' : 's'}.`);
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

  // Phase 2: a manual run now respects the sending window by default. Only an
  // admin can deliberately bypass it, and only after confirming in the dialog.
  const runNow = async () => {
    setNotice('');
    setError('');
    setRunning(true);
    try {
      const { data } = await api.post('/enrollments/run', { ignoreWindow: !respectWindow });
      const s = data.summary;
      setNotice(
        `Automation run${data.ignoreWindow ? ' (sending window bypassed)' : ''}: sent ${s.sent}, ` +
          `completed ${s.completed}, retried ${s.retried}, failed ${s.failed}, ` +
          `skipped(window) ${s.skippedWindow}, skipped(locked) ${s.skippedLocked ?? 0}.`
      );
      setRunDialog(false);
      fetchRows();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to run automation');
      setRunDialog(false);
    } finally {
      setRunning(false);
    }
  };

  // Phase 5: campaigns are multi-step again, so show real progress through the
  // sequence. `currentStepIndex` is the 0-based index of the step the
  // enrollment is WAITING on, so the human-readable position is index + 1 while
  // it is still running. A finished enrollment shows the number it reached
  // rather than a step it will never be sent.
  const stepProgress = (row) => {
    const total = row.campaign?.steps?.length;
    if (!total) return '—';
    const sent = (row.sentSteps || []).length;
    if (['completed', 'replied', 'cancelled', 'failed'].includes(row.status)) {
      return `${sent} of ${total} sent`;
    }
    return `Step ${Math.min((row.currentStepIndex ?? 0) + 1, total)} of ${total}`;
  };
  // Rendered in the viewer's own timezone — the worker schedules in the
  // contact's zone, but an operator reads these in theirs.
  const fmt = (d) => (d ? new Date(d).toLocaleString() : '—');

  // 'replied' gets its own colour: it is a deliberate stop, not a failure.
  const statusChipClass = (s) => {
    if (s === 'active') return 'chip chip-on';
    if (s === 'replied') return 'chip chip-warn';
    if (s === 'failed') return 'chip chip-invalid';
    return 'chip';
  };

  const selectorDisabled = !campaignId || noImport || requiresBatch;
  // "Batch 2" — the batch the picker is showing, by name.
  const batchName = scope?.batch ? `Batch ${scope.batch.number}` : '';

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Enrollments</h1>
          <div className="page-sub">Track each contact's progress through a campaign.</div>
        </div>
        <div className="head-actions">
          {isAdmin && (
            <button
              className="btn"
              onClick={() => { setRespectWindow(true); setRunDialog(true); }}
            >
              Run automation now
            </button>
          )}
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

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-info">{notice}</div>}

      {/* Enroll form */}
      <form className="import-bar" onSubmit={enroll}>
        <select className="input" value={campaignId} onChange={(e) => onCampaignChange(e.target.value)} required>
          <option value="">Select campaign…</option>
          {campaigns.map((c) => (
            <option key={c._id} value={c._id}>
              {c.name}{c.import?.filename ? ` — ${c.import.filename}` : ''} ({c.steps?.length || 0} steps)
            </option>
          ))}
        </select>

        {/* CSV -> Batch. A campaign tied to a batch shows it (fixed); otherwise,
            when the list has batches, one must be chosen here. */}
        {campaignId && scope?.import && scope.batches.length > 0 && (
          scope.fixed ? (
            <span className="chip chip-on" title={`Contact list: ${scope.import.filename || ''}`}>
              {scope.import.filename} · {batchName || 'Batch'}
            </span>
          ) : (
            <select
              className="input"
              aria-label="Batch"
              value={enrollBatch}
              onChange={(e) => onBatchChange(e.target.value)}
              required
            >
              <option value="">{scope.import.filename}: select batch…</option>
              {scope.batches.map((b) => (
                <option key={b._id} value={String(b._id)}>{batchOptionLabel(b)}</option>
              ))}
            </select>
          )
        )}

        {/* Multi-select contact picker (eligible contacts only) */}
        <div className="ms" ref={dropdownRef}>
          <button
            type="button"
            className="ms-btn"
            ref={triggerRef}
            onClick={openDropdown}
            disabled={selectorDisabled}
            aria-haspopup="listbox"
            aria-expanded={dropdownOpen}
          >
            <span className={selectedCount === 0 ? 'muted' : ''}>{buttonLabel()}</span>
            <svg className="ms-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {dropdownOpen && !selectorDisabled && (
            <div className={`ms-panel${dropUp ? ' ms-panel-up' : ''}`} role="listbox">
              <input
                className="input ms-search"
                placeholder="Search name, phone or email…"
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                autoFocus
              />
              <label className="ms-opt ms-all">
                <input ref={selectAllRef} type="checkbox" checked={isAllSelected} onChange={toggleSelectAll} disabled={eligibleTotal === 0} />
                <span>
                  Select all{eligibleTotal ? ` (${eligibleTotal.toLocaleString()})` : ' (0)'}
                  {batchName ? ` from ${batchName}` : ''}
                </span>
              </label>
              <div className="ms-divider" />
              <div className="ms-list">
                {contactsLoading ? (
                  <div className="ms-empty"><Spinner label="Loading…" /></div>
                ) : contacts.length === 0 ? (
                  <div className="ms-empty muted small">
                    {contactSearch ? 'No matching contacts.' : 'No eligible contacts.'}
                  </div>
                ) : (
                  contacts.map((c) => (
                    <label className="ms-opt" key={c._id}>
                      <input type="checkbox" checked={isChecked(c._id)} onChange={() => toggleContact(c._id)} />
                      <span className="ms-name">{c.name || c.phone}</span>
                      <span className="ms-phone muted small">{c.phone}</span>
                    </label>
                  ))
                )}
              </div>
              <div className="ms-foot">
                <span className="muted small">
                  {selectedCount.toLocaleString()} selected
                  {!contactSearch && batchName
                    ? (eligibleTotal > contacts.length
                      ? ` · showing ${contacts.length} of ${eligibleTotal.toLocaleString()} contacts from ${batchName}`
                      : ` · showing ${eligibleTotal.toLocaleString()} contacts from ${batchName}`)
                    : eligibleTotal > contacts.length && !contactSearch ? ` · showing ${contacts.length} of ${eligibleTotal.toLocaleString()}` : ''}
                </span>
                {selectedCount > 0 && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={clearSelection}>Clear</button>
                )}
              </div>
            </div>
          )}
        </div>

        <button className="btn btn-primary" type="submit" disabled={enrolling || !campaignId || selectedCount === 0}>
          {enrolling ? 'Enrolling…' : `Enroll${selectedCount > 1 ? ` (${selectedCount.toLocaleString()})` : ''}`}
        </button>
      </form>

      {/* Batch allocation: enroll the NEXT N contacts of this campaign's list
          (or all that remain) without picking them one by one. The list keeps
          its place between visits. */}
      {(() => {
        const selected = campaigns.find((c) => c._id === campaignId);
        const listId = selected?.import?._id || (typeof selected?.import === 'string' ? selected.import : null);
        if (!selected || !listId || selected.batch) return null;
        return (
          <details className="card batch-details">
            <summary>
              Enroll the next batch from {selected.import?.filename || 'this campaign’s list'}
            </summary>
            <ImportBatchPanel
              key={`${campaignId}:${listId}`}
              importId={listId}
              fixedCampaign={{ _id: selected._id, name: selected.name }}
              onAllocated={() => { fetchRows(); fetchEligible(campaignId, ''); }}
            />
          </details>
        );
      })()}

      {campaignId && scope?.import && (
        <div className="muted small scope-line" aria-live="polite">
          {scope.fixed && batchName
            ? <>This campaign is for <strong>{batchName}</strong> of <strong>{scope.import.filename}</strong> only. </>
            : null}
          {requiresBatch && <>{scope.import.filename} has batches — choose the batch to enroll from. </>}
          {!requiresBatch && batchName && <>Showing {eligibleTotal.toLocaleString()} eligible contact{eligibleTotal === 1 ? '' : 's'} from {batchName}.</>}
          {scope.batches.length === 0 && !scope.batch && <>{NO_BATCHES_MESSAGE}</>}
        </div>
      )}

      {campaignId && noImport && (
        <div className="alert alert-info">
          This campaign has no contact list. Edit the campaign and select a CSV import to enable enrollment.
        </div>
      )}

      {/* Status filter */}
      <div className="filters">
        <select className="input" value={statusFilter} onChange={(e) => { setPage(1); setStatusFilter(e.target.value); }}>
          <option value="">All statuses</option>
          <option value="active">active</option>
          <option value="paused">paused</option>
          <option value="completed">completed</option>
          <option value="replied">replied</option>
          <option value="failed">failed</option>
          <option value="cancelled">cancelled</option>
        </select>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Contact</th>
              <th>Campaign</th>
              <th>Status</th>
              <th>Step</th>
              <th>Next send (your time)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6}><Spinner label="Loading enrollments…" /></td></tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState
                    icon={EnrollIcon}
                    title={statusFilter ? `No ${statusFilter} enrollments` : 'No enrollments yet'}
                    hint={
                      statusFilter
                        ? 'Try a different status filter.'
                        : 'Pick a campaign, choose one or more of its eligible contacts, and click Enroll.'
                    }
                  />
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row._id}>
                  <td>{row.contact ? (row.contact.name || row.contact.phone) : <span className="muted">—</span>}</td>
                  <td>{row.campaign?.name || <span className="muted">—</span>}</td>
                  <td>
                    <span className={statusChipClass(row.status)}>{row.status}</span>
                    {/* Why automation stopped early — shown only when it adds
                        something the status does not already say. */}
                    {row.stopReason && row.stopReason !== row.status && (
                      <div className="muted small">{row.stopReason}</div>
                    )}
                  </td>
                  <td>{stepProgress(row)}</td>
                  <td className="small">{row.status === 'active' ? fmt(row.nextRunAt) : '—'}</td>
                  <td className="row-actions">
                    {row.status === 'active' && <button className="btn btn-sm" onClick={() => changeStatus(row, 'paused')}>Pause</button>}
                    {row.status === 'paused' && <button className="btn btn-sm" onClick={() => changeStatus(row, 'active')}>Resume</button>}
                    {['active', 'paused'].includes(row.status) && <button className="btn btn-sm" onClick={() => changeStatus(row, 'cancelled')}>Cancel</button>}
                    <button className="btn btn-sm btn-danger" onClick={() => deleteEnrollment(row)}>Delete</button>
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

      {runDialog && (
        <Modal title="Run automation now" onClose={() => setRunDialog(false)}>
          <p className="muted small">
            Processes every enrollment that is already due, right now, instead of waiting for the
            next scheduled minute.
          </p>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={respectWindow}
              onChange={(e) => setRespectWindow(e.target.checked)}
            />
            <span>Respect sending window (recommended)</span>
          </label>
          {!respectWindow && (
            <div className="alert alert-error">
              <div>
                Messages will be sent <strong>outside your configured sending window</strong>,
                including on days you excluded. Sending to US numbers outside permitted hours can
                breach TCPA quiet-hour rules. Opt-out, mobile-only and duplicate-send protections
                still apply.
              </div>
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setRunDialog(false)} disabled={running}>
              Cancel
            </button>
            <button
              type="button"
              className={respectWindow ? 'btn btn-primary' : 'btn btn-danger'}
              onClick={runNow}
              disabled={running}
            >
              {running ? 'Running…' : respectWindow ? 'Run now' : 'Run now, ignore window'}
            </button>
          </div>
        </Modal>
      )}

      {confirm && (
        <ConfirmDialog
          title={
            confirm.type === 'single'
              ? 'Delete enrollment?'
              : `Delete all ${pagination.total} ${statusFilter || ''} enrollment${pagination.total === 1 ? '' : 's'}?`.replace('  ', ' ')
          }
          confirmLabel={confirm.type === 'single' ? 'Delete' : 'Delete All'}
          busy={deleting}
          onConfirm={performDelete}
          onClose={() => setConfirm(null)}
          message={
            confirm.type === 'single' ? (
              <p>
                Remove{' '}
                <strong>{confirm.enrollment.contact?.name || confirm.enrollment.contact?.phone || 'this contact'}</strong>{' '}
                from <strong>{confirm.enrollment.campaign?.name || 'this campaign'}</strong>? The contact, campaign,
                conversation and SMS history are kept.
              </p>
            ) : (
              <p>
                This will permanently delete{' '}
                <strong>
                  all {pagination.total} {statusFilter ? `${statusFilter} ` : ''}enrollment{pagination.total === 1 ? '' : 's'}
                </strong>
                . Contacts, campaigns and message history are kept. This cannot be undone.
              </p>
            )
          }
        />
      )}
    </div>
  );
}

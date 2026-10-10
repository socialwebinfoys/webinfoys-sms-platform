// Batch allocation for one imported list: Total / Allocated / Remaining, an
// All Remaining / Custom choice, an optional campaign to enroll the batch into,
// and the batch history. Everything shown comes from the server's persisted
// state, so reopening a list shows exactly where it left off — no re-upload.
//
// Used in three places: right after an import, from "Imported lists", and on
// the Enrollments page for the selected campaign's list (`fixedCampaign`).
import { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import Spinner from './Spinner';
import ConfirmDialog from './ConfirmDialog';
import {
  deleteBatchMessage,
  requestDeleteBatch,
  formatCount,
  validateCustomCount,
  batchSize,
  describeBatch,
  allocationPayload,
  allocationNotice,
  fetchAllocation,
  requestAllocation,
} from '../utils/importBatch';

export default function ImportBatchPanel({
  importId,
  campaigns = null, // options for "Enroll this batch into" (optional)
  fixedCampaign = null, // { _id, name } — always enroll into this one
  showHistory = true,
  onAllocated,
  // When given, each batch in the history gets a "View" action (Contacts page).
  onViewBatch = null,
  // Admins may delete a batch grouping once its work is done.
  canDeleteBatches = false,
  onBatchDeleted = null,
  // State to show before the first fetch returns (the fetch still runs).
  initialData = null,
}) {
  const [batchToDelete, setBatchToDelete] = useState(null);
  const [deletingBatch, setDeletingBatch] = useState(false);
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('all');
  const [customRaw, setCustomRaw] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  // One request per click, even if the button is pressed twice quickly.
  const lockRef = useRef(false);

  useEffect(() => {
    if (!importId) return undefined;
    let cancelled = false;
    if (!initialData) setLoading(true);
    setError('');
    fetchAllocation(api, importId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Failed to load this list');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // initialData only seeds the first render; it never re-triggers a fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importId]);

  // Soft delete of the grouping only; the server refuses while the batch has
  // live enrollments, and keeps every contact.
  const deleteBatch = async () => {
    if (!batchToDelete || deletingBatch) return;
    setDeletingBatch(true);
    setError('');
    setNotice('');
    try {
      const res = await requestDeleteBatch(api, importId, batchToDelete._id);
      setData(res.data);
      setNotice(res.message);
      if (onBatchDeleted) onBatchDeleted(res);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to delete the batch');
    } finally {
      setDeletingBatch(false);
      setBatchToDelete(null);
    }
  };

  if (loading) return <Spinner label="Loading list…" />;
  if (!data) return error ? <div className="alert alert-error">{error}</div> : null;

  const remaining = data.remaining;
  const size = batchSize(mode, customRaw, remaining);
  const customCheck = mode === 'custom' ? validateCustomCount(customRaw, remaining) : null;
  const targetId = fixedCampaign ? fixedCampaign._id : campaignId;

  const submit = async (e) => {
    e.preventDefault();
    if (lockRef.current || size === null) return;
    lockRef.current = true;
    setSubmitting(true);
    setError('');
    setNotice('');
    try {
      const res = await requestAllocation(api, importId, allocationPayload(mode, customRaw, targetId));
      setData(res.data);
      setCustomRaw('');
      setMode('all');
      setNotice(allocationNotice(res));
      if (onAllocated) onAllocated(res);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to allocate the batch');
      // The list may have changed under us (another operator); show the truth.
      fetchAllocation(api, importId).then(setData).catch(() => {});
    } finally {
      lockRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="batch-panel">
      <table className="kv">
        <tbody>
          {data.filename && (
            <tr><td className="muted">List</td><td>{data.filename}</td></tr>
          )}
          <tr>
            <td className="muted">Total contacts</td>
            <td>
              {formatCount(data.contacts ?? data.total)}
              {data.contacts !== undefined && data.contacts < data.total && (
                <span className="muted small"> ({formatCount(data.total - data.contacts)} since deleted)</span>
              )}
            </td>
          </tr>
          <tr><td className="muted">Allocated</td><td>{formatCount(data.allocated)}</td></tr>
          <tr><td className="muted">Remaining</td><td><strong>{formatCount(remaining)}</strong></td></tr>
        </tbody>
      </table>

      {remaining === 0 ? (
        <p className="muted small">Every contact in this list has been allocated.</p>
      ) : (
        <form onSubmit={submit}>
          <div className="field" role="radiogroup" aria-label="How many contacts to use">
            <label className="checkbox-field">
              <input
                type="radio"
                name={`batch-mode-${importId}`}
                value="all"
                checked={mode === 'all'}
                onChange={() => setMode('all')}
                disabled={submitting}
              />
              <span>All Remaining ({formatCount(remaining)})</span>
            </label>
            <label className="checkbox-field">
              <input
                type="radio"
                name={`batch-mode-${importId}`}
                value="custom"
                checked={mode === 'custom'}
                onChange={() => setMode('custom')}
                disabled={submitting}
              />
              <span>Custom</span>
            </label>
            {mode === 'custom' && (
              <input
                type="number"
                className="input input-narrow"
                min="1"
                max={remaining}
                step="1"
                inputMode="numeric"
                aria-label="Number of contacts to use"
                placeholder="e.g. 300"
                value={customRaw}
                onChange={(e) => setCustomRaw(e.target.value)}
                disabled={submitting}
              />
            )}
          </div>

          {size !== null ? (
            <div className="alert alert-info small">{describeBatch(size, remaining)}</div>
          ) : (
            customCheck && customRaw !== '' && <div className="alert alert-error small">{customCheck.error}</div>
          )}

          {fixedCampaign ? (
            <p className="muted small">The batch will be enrolled into <strong>{fixedCampaign.name}</strong>.</p>
          ) : campaigns && (
            <label className="field">
              <span>Enroll this batch into (optional)</span>
              <select
                className="input"
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
                disabled={submitting}
              >
                <option value="">— Allocate only —</option>
                {campaigns.map((c) => (
                  <option key={c._id} value={c._id}>{c.name}</option>
                ))}
              </select>
            </label>
          )}

          <button className="btn btn-primary" type="submit" disabled={submitting || size === null}>
            {submitting
              ? 'Allocating…'
              : targetId
                ? `Allocate & enroll${size ? ` ${formatCount(size)}` : ''}`
                : `Allocate${size ? ` ${formatCount(size)}` : ''}`}
          </button>
        </form>
      )}

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-info">{notice}</div>}

      {showHistory && data.batches.length > 0 && (
        <div className="table-wrap batch-history">
          <table className="table">
            <thead>
              <tr>
                <th>Batch</th>
                <th>Contacts</th>
                <th>Campaign</th>
                <th>Allocated</th>
                {(onViewBatch || canDeleteBatches) && <th></th>}
              </tr>
            </thead>
            <tbody>
              {data.batches.map((b) => {
                const isCurrent = data.currentBatch && String(data.currentBatch._id) === String(b._id);
                const deleted = b.status === 'deleted';
                // Only a finished batch can be viewed or deleted (not one mid-allocation).
                const actionable = b.status === 'complete';
                return (
                  <tr key={b._id} className={deleted ? 'muted' : undefined}>
                    <td>
                      Batch {b.number}
                      {b.mode === 'all' ? <span className="muted small"> (all remaining)</span> : null}
                      {isCurrent && <span className="chip chip-on" style={{ marginLeft: 6 }}>current</span>}
                      {deleted && <span className="chip" style={{ marginLeft: 6 }}>deleted</span>}
                    </td>
                    <td>
                      {formatCount(b.size)}
                      {b.contacts !== undefined && b.contacts !== b.size && (
                        <span className="muted small"> ({formatCount(b.contacts)} still exist)</span>
                      )}
                    </td>
                    <td className="small">
                      {b.campaign
                        ? `${b.campaignName || 'Campaign'} · ${formatCount(b.enrollment?.enrolled)} enrolled`
                        : <span className="muted">Allocated only</span>}
                    </td>
                    <td className="small">{new Date(b.allocatedAt).toLocaleString()}</td>
                    {(onViewBatch || canDeleteBatches) && (
                      <td className="row-actions">
                        {onViewBatch && actionable && (
                          <button type="button" className="btn btn-sm" onClick={() => onViewBatch(b)}>
                            View
                          </button>
                        )}
                        {canDeleteBatches && actionable && (
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            onClick={() => setBatchToDelete(b)}
                            disabled={deletingBatch}
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {batchToDelete && (
        <ConfirmDialog
          title={`Delete Batch ${batchToDelete.number}?`}
          confirmLabel={`Delete Batch ${batchToDelete.number}`}
          busy={deletingBatch}
          onConfirm={deleteBatch}
          onClose={() => { if (!deletingBatch) setBatchToDelete(null); }}
          message={
            <>
              <p><strong>{deleteBatchMessage(batchToDelete.number)}</strong></p>
              <p className="muted small">
                Its {formatCount(batchToDelete.contacts ?? batchToDelete.size)} contacts are kept — they stay
                in Contacts and do not return to the remaining pool, so they are never allocated again.
                Campaigns, enrollments and message history are not affected.
              </p>
            </>
          }
        />
      )}
    </div>
  );
}

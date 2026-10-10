// Campaign management: list + multi-step campaign builder (create/edit), clone
// and per-campaign stats.
import { useEffect, useState, useCallback } from 'react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import ConfirmDialog from '../components/ConfirmDialog';
import SmsCounter from '../components/SmsCounter';
import {
  fetchAllocation,
  selectableBatches,
  batchOptionLabel,
  formatCount,
  NO_BATCHES_MESSAGE,
} from '../utils/importBatch';

const CampaignsIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 11l18-5v12L3 14v-3z" /><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
  </svg>
);

// Phase 5: a campaign is an ordered SEQUENCE of steps again. Each step is a
// message (template or custom body) plus the delay to wait before sending it,
// measured from the previous step. Step 1's delay is the wait after enrolment.
//
// `_id` is present only for steps that already exist on the server. Sending it
// back is what keeps an in-flight enrollment pointing at the same message when
// the sequence is reordered — see server/controllers/campaignController.js.
const emptyStep = () => ({ _id: null, templateId: '', body: '', delayValue: 0, delayUnit: 'hours' });
const emptyForm = () => ({
  name: '',
  description: '',
  isActive: true,
  import: '',
  // The batch of that list this campaign is for. Required when the list has
  // batches — the campaign's audience is then exactly that batch.
  batch: '',
  steps: [emptyStep()],
});

const DELAY_UNITS = ['minutes', 'hours', 'days'];

// "Immediately" reads better than "after 0 hours" for the first step.
function delayLabel(step, index) {
  const n = Number(step.delayValue) || 0;
  if (n === 0) return index === 0 ? 'Send immediately' : 'Send straight after the previous step';
  const unit = n === 1 ? step.delayUnit.replace(/s$/, '') : step.delayUnit;
  return index === 0 ? `Wait ${n} ${unit} after enrolling` : `Wait ${n} ${unit} after the previous step`;
}

export default function Campaigns() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [campaigns, setCampaigns] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, pages: 0 });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [modal, setModal] = useState({ open: false, mode: 'create', id: null });
  // Phase 5: per-campaign performance, keyed by campaign id.
  const [stats, setStats] = useState({});
  const [editWarning, setEditWarning] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [imports, setImports] = useState([]); // CSV/contact imports for the picker
  // The chosen list's batches (persisted allocation state), loaded per list.
  const [formAllocation, setFormAllocation] = useState(null);
  useEffect(() => {
    if (!modal.open || !form.import) { setFormAllocation(null); return undefined; }
    let cancelled = false;
    setFormAllocation(null);
    fetchAllocation(api, form.import)
      .then((d) => { if (!cancelled) setFormAllocation(d); })
      .catch(() => { if (!cancelled) setFormAllocation({ batches: [], failed: true }); });
    return () => { cancelled = true; };
  }, [modal.open, form.import]);
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(null); // { type: 'single'|'all', campaign? }
  const [deleting, setDeleting] = useState(false);

  const fetchCampaigns = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/campaigns', {
        params: { search: search || undefined, page, limit: 20 },
      });
      setCampaigns(data.data);
      setPagination(data.pagination);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load campaigns');
    } finally {
      setLoading(false);
    }
  }, [search, page]);

  // Phase 5: stats are a separate, read-only call so a slow aggregation never
  // delays the campaign list itself. Indexed by campaign id for row lookup.
  const fetchStats = useCallback(async () => {
    try {
      const { data } = await api.get('/campaigns/stats');
      const map = {};
      (data.data || []).forEach((row) => { map[row.campaign] = row; });
      setStats(map);
    } catch {
      setStats({});
    }
  }, []);
  useEffect(() => { fetchStats(); }, [fetchStats]);

  useEffect(() => {
    const t = setTimeout(fetchCampaigns, 300);
    return () => clearTimeout(t);
  }, [fetchCampaigns]);

  // Load templates for the per-step "insert template" dropdown.
  // Phase 7: the lightweight options endpoint, so an account with more than
  // 100 templates still shows all of them in the picker. It returns id + name
  // only, so the body of a SELECTED template is fetched on demand below rather
  // than downloading every body up front.
  const loadTemplates = async () => {
    try {
      const { data } = await api.get('/templates/options');
      setTemplates(data.data);
    } catch {
      setTemplates([]);
    }
  };

  // Cache of templateId -> body, filled only for templates actually chosen.
  const [templateBodies, setTemplateBodies] = useState({});
  const loadTemplateBody = useCallback(async (id) => {
    if (!id) return;
    setTemplateBodies((prev) => (id in prev ? prev : { ...prev, [id]: null }));
    try {
      const { data } = await api.get(`/templates/${id}`);
      setTemplateBodies((prev) => ({ ...prev, [id]: data.data.body }));
    } catch {
      setTemplateBodies((prev) => ({ ...prev, [id]: '' }));
    }
  }, []);

  // Load CSV/contact imports for the "Contact list" picker.
  const loadImports = async () => {
    try {
      const { data } = await api.get('/contact-imports');
      setImports(data.data);
    } catch {
      setImports([]);
    }
  };

  const openCreate = () => {
    setForm(emptyForm());
    setFormError('');
    loadTemplates();
    loadImports();
    setModal({ open: true, mode: 'create', id: null });
  };

  const openEdit = (c) => {
    // Load the real sequence. Every existing step keeps its _id so the server
    // can tell "this is the same step" from "this is a new one".
    const steps = (c.steps && c.steps.length ? c.steps : [{}]).map((s) => ({
      _id: s._id || null,
      templateId: s.template ? (s.template._id || s.template) : '',
      body: s.template ? '' : (s.body || ''),
      delayValue: s.delayValue ?? 0,
      delayUnit: s.delayUnit || 'hours',
    }));
    setForm({
      name: c.name || '',
      description: c.description || '',
      isActive: c.isActive,
      import: c.import ? (c.import._id || c.import) : '',
      batch: c.batch ? String(c.batch) : '',
      steps,
    });
    setFormError('');
    setEditWarning(null);
    loadTemplates();
    loadImports();
    // Fetch the body of every template already used by a step, so the preview
    // is populated when the dialog opens.
    steps.forEach((s) => { if (s.templateId) loadTemplateBody(s.templateId); });
    setModal({ open: true, mode: 'edit', id: c._id });
  };

  const closeModal = () => {
    setModal({ open: false, mode: 'create', id: null });
    setEditWarning(null);
  };

  // ---- step builder ------------------------------------------------------
  const updateStep = (index, patch) => {
    setForm((f) => ({
      ...f,
      steps: f.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }));
  };
  const addStep = () => setForm((f) => ({ ...f, steps: [...f.steps, emptyStep()] }));
  const removeStep = (index) =>
    setForm((f) => ({
      ...f,
      // Never leave a campaign with no steps — the server rejects that anyway.
      steps: f.steps.length === 1 ? f.steps : f.steps.filter((_, i) => i !== index),
    }));
  const moveStep = (index, direction) =>
    setForm((f) => {
      const target = index + direction;
      if (target < 0 || target >= f.steps.length) return f;
      const steps = [...f.steps];
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...f, steps };
    });

  // How many enrollments are still in flight for the campaign being edited —
  // fetched so the operator is warned BEFORE they change a live sequence.
  const [liveEnrollments, setLiveEnrollments] = useState(0);
  useEffect(() => {
    if (!modal.open || modal.mode !== 'edit' || !modal.id) { setLiveEnrollments(0); return; }
    let cancelled = false;
    (async () => {
      try {
        const [a, p] = await Promise.all([
          api.get('/enrollments', { params: { campaign: modal.id, status: 'active', limit: 1 } }),
          api.get('/enrollments', { params: { campaign: modal.id, status: 'paused', limit: 1 } }),
        ]);
        if (!cancelled) setLiveEnrollments((a.data.pagination?.total || 0) + (p.data.pagination?.total || 0));
      } catch { if (!cancelled) setLiveEnrollments(0); }
    })();
    return () => { cancelled = true; };
  }, [modal.open, modal.mode, modal.id]);

  const saveCampaign = async (e) => {
    e.preventDefault();
    setFormError('');
    setEditWarning(null);

    // Each step needs exactly one message source.
    for (let i = 0; i < form.steps.length; i += 1) {
      const s = form.steps[i];
      if (!s.templateId && !String(s.body || '').trim()) {
        setFormError(`Step ${i + 1}: choose a template or enter a custom message`);
        return;
      }
      if (Number(s.delayValue) < 0 || Number.isNaN(Number(s.delayValue))) {
        setFormError(`Step ${i + 1}: delay must be zero or more`);
        return;
      }
    }

    setSaving(true);
    const payload = {
      name: form.name,
      description: form.description,
      isActive: form.isActive,
      import: form.import || undefined,
      // Sent whenever a list is chosen, so the server validates the pair.
      batch: form.import ? (form.batch || null) : undefined,
      steps: form.steps.map((s) => ({
        // Only send _id for steps that already exist on the server.
        ...(s._id ? { _id: s._id } : {}),
        ...(s.templateId ? { templateId: s.templateId } : { body: s.body }),
        delayValue: Number(s.delayValue) || 0,
        delayUnit: s.delayUnit,
      })),
    };
    try {
      if (modal.mode === 'create') {
        await api.post('/campaigns', payload);
        closeModal();
      } else {
        const { data } = await api.put(`/campaigns/${modal.id}`, payload);
        // The server reports how many in-flight enrollments the edit touched;
        // surface it rather than letting the change pass silently.
        if (data.warning) {
          setEditWarning(data.warning);
          setNotice(data.warning.message);
        }
        closeModal();
      }
      fetchCampaigns();
      fetchStats();
    } catch (err) {
      setFormError(err.response?.data?.message || 'Failed to save campaign');
    } finally {
      setSaving(false);
    }
  };

  // ---- clone / activate --------------------------------------------------
  const cloneCampaign = async (c) => {
    setError(''); setNotice('');
    try {
      const { data } = await api.post(`/campaigns/${c._id}/clone`);
      setNotice(`Created "${data.data.name}" as an inactive copy. Review it, then activate it when you are ready.`);
      fetchCampaigns();
      fetchStats();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to clone campaign');
    }
  };

  const toggleActive = async (c) => {
    setError(''); setNotice('');
    try {
      await api.put(`/campaigns/${c._id}`, { isActive: !c.isActive });
      fetchCampaigns();
      fetchStats();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to update campaign');
    }
  };

  const deleteCampaign = (c) => { setError(''); setNotice(''); setConfirm({ type: 'single', campaign: c }); };
  const deleteAll = () => { setError(''); setNotice(''); setConfirm({ type: 'all' }); };

  const performDelete = async () => {
    if (!confirm) return;
    setDeleting(true);
    setError('');
    try {
      if (confirm.type === 'single') {
        // Phase 5: a campaign with enrollments answers 409 and must be deleted
        // again WITH ?force=true. The force request is a second, explicit
        // confirmation — never sent automatically on the first click.
        await api.delete(`/campaigns/${confirm.campaign._id}${confirm.force ? '?force=true' : ''}`);
        setNotice('Campaign deleted successfully.');
      } else {
        const { data } = await api.delete('/campaigns');
        setNotice(`Deleted ${data.deletedCount} campaign${data.deletedCount === 1 ? '' : 's'}.`);
        setPage(1);
      }
      setConfirm(null);
      fetchCampaigns();
      fetchStats();
    } catch (err) {
      const res = err.response?.data;
      // 409 = "this campaign has enrollments". Re-open the dialog in force mode
      // so the operator sees exactly what will be destroyed and confirms again.
      if (err.response?.status === 409 && res?.requiresForce) {
        setConfirm({
          type: 'single',
          campaign: confirm.campaign,
          force: true,
          enrollmentCount: res.enrollmentCount,
          liveEnrollmentCount: res.liveEnrollmentCount,
        });
      } else {
        setError(res?.message || 'Failed to delete. Please try again.');
        setConfirm(null);
      }
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Campaigns</h1>
          <div className="page-sub">Multi-step message sequences sent to a contact list.</div>
        </div>
        <div className="head-actions">
          <button className="btn btn-primary" onClick={openCreate}>
            + New campaign
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

      <div className="filters">
        <input
          className="input"
          placeholder="Search campaigns…"
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch(e.target.value);
          }}
        />
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Steps</th>
              <th>Performance</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5}>
                  <Spinner label="Loading campaigns…" />
                </td>
              </tr>
            ) : campaigns.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <EmptyState
                    icon={CampaignsIcon}
                    title={search ? 'No matching campaigns' : 'No campaigns yet'}
                    hint={
                      search
                        ? 'Try a different search term.'
                        : 'Create a campaign to send an initial message to a contact list.'
                    }
                  />
                </td>
              </tr>
            ) : (
              campaigns.map((c) => {
                const st = stats[c._id];
                const stepCount = (c.steps || []).length;
                return (
                  <tr key={c._id}>
                    <td>
                      {c.name}
                      {c.description ? <div className="muted small">{c.description}</div> : null}
                      {c.import?.filename ? (
                        <div className="muted small">
                          {c.import.filename}
                          {c.batchInfo ? (
                            <> · <strong>{c.batchInfo.number ? `Batch ${c.batchInfo.number}` : 'Batch'}</strong>
                              {' '}({formatCount(c.batchInfo.contacts)} contacts){c.batchInfo.status === 'deleted' ? ' — batch deleted' : ''}</>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                    <td className="small">
                      <span className="chip">{stepCount} step{stepCount === 1 ? '' : 's'}</span>
                      {stepCount > 1 && (
                        <div className="muted small" style={{ marginTop: 4 }}>
                          {(c.steps || [])
                            .map((s, i) => (i === 0 ? 'now' : `+${s.delayValue}${(s.delayUnit || 'h')[0]}`))
                            .join(' → ')}
                        </div>
                      )}
                    </td>
                    {/* Phase 5 stats row. Every figure comes from
                        GET /campaigns/stats — see its `definitions` payload. */}
                    <td className="small">
                      {st ? (
                        <div className="muted small">
                          <div>
                            {st.enrolled} enrolled · {st.sent} sent · {st.delivered} delivered
                          </div>
                          <div>
                            {st.replied} replied ({Math.round(st.replyRate * 100)}%) · {st.optOuts} opt-out
                            {st.optOuts === 1 ? '' : 's'}
                          </div>
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <button
                        className={c.isActive ? 'chip chip-on' : 'chip'}
                        onClick={() => toggleActive(c)}
                        title={c.isActive ? 'Pause this campaign' : 'Activate this campaign'}
                        style={{ cursor: 'pointer', border: 'none' }}
                      >
                        {c.isActive ? 'active' : 'paused'}
                      </button>
                    </td>
                    <td className="row-actions">
                      <button className="btn btn-sm" onClick={() => cloneCampaign(c)} title="Create an inactive copy">
                        Clone
                      </button>
                      <button className="btn btn-sm" onClick={() => openEdit(c)}>
                        Edit
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => deleteCampaign(c)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

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

      {modal.open && (
        <Modal
          wide
          title={modal.mode === 'create' ? 'New campaign' : 'Edit campaign'}
          onClose={closeModal}
        >
          <form onSubmit={saveCampaign}>
            {formError && <div className="alert alert-error">{formError}</div>}
            <label className="field">
              <span>Name *</span>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </label>
            <label className="field">
              <span>Description</span>
              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Contact list / CSV{modal.mode === 'create' ? ' *' : ''}</span>
              <select
                className="input"
                value={form.import}
                // A new list means its batches must be chosen again.
                onChange={(e) => setForm({ ...form, import: e.target.value, batch: '' })}
                required={modal.mode === 'create'}
              >
                <option value="">Select imported CSV…</option>
                {imports.map((imp) => (
                  <option key={imp._id} value={imp._id}>
                    {imp.filename || 'import'} ({imp.contactCount} contacts)
                  </option>
                ))}
              </select>
            </label>
            {/* CSV -> Batch. When the list has batches the campaign is for ONE of
                them, and the server enforces it; the whole list is never used. */}
            {form.import && (() => {
              if (!formAllocation) return <div className="muted small">Loading batches…</div>;
              const batches = selectableBatches(formAllocation);
              const list = imports.find((i) => String(i._id) === String(form.import));
              if (batches.length === 0) {
                return (
                  <div className="alert alert-info small">
                    {NO_BATCHES_MESSAGE} Until then this campaign uses the whole list
                    {list ? ` (${formatCount(list.contactCount)} contacts)` : ''}.
                  </div>
                );
              }
              const chosen = batches.find((b) => String(b._id) === String(form.batch));
              const boundElsewhere = form.batch && !chosen;
              return (
                <>
                  <label className="field">
                    <span>Batch *</span>
                    <select
                      className="input"
                      aria-label="Batch"
                      value={chosen ? String(chosen._id) : ''}
                      onChange={(e) => setForm({ ...form, batch: e.target.value })}
                      required={modal.mode === 'create' || !!form.batch}
                    >
                      <option value="">Select batch…</option>
                      {batches.map((b) => (
                        <option key={b._id} value={String(b._id)}>{batchOptionLabel(b)}</option>
                      ))}
                    </select>
                  </label>
                  {boundElsewhere && (
                    <div className="alert alert-error small">
                      This campaign’s batch has been deleted. Choose another batch of this list.
                    </div>
                  )}
                  <div className="alert alert-info small" aria-live="polite">
                    {chosen ? (
                      <>
                        <strong>Audience: {formatCount(chosen.contacts ?? chosen.size)} contact{(chosen.contacts ?? chosen.size) === 1 ? '' : 's'}</strong>
                        {' '}— Batch {chosen.number} of {list?.filename || 'this list'} only.
                      </>
                    ) : modal.mode === 'edit'
                      ? 'This campaign is not tied to one batch: contacts are enrolled into it one chosen batch at a time (Enrollments). Choose a batch here to tie it to that batch only.'
                      : 'Choose the batch this campaign is for.'}
                  </div>
                </>
              );
            })()}
            {modal.mode === 'edit' && (
              <div className="alert alert-info small">
                Changing the contact list or batch affects which contacts are eligible for future enrollment. Existing enrollments are not affected.
              </div>
            )}
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              />
              <span>Active</span>
            </label>

            {/* Phase 5: warn BEFORE a live sequence is changed. The server
                returns the real affected/orphaned counts after saving; this is
                the up-front heads-up. */}
            {modal.mode === 'edit' && liveEnrollments > 0 && (
              <div className="alert alert-error small">
                <strong>{liveEnrollments} enrollment{liveEnrollments === 1 ? ' is' : 's are'} still in flight on this campaign.</strong>{' '}
                Editing a step changes what they will receive. Each one keeps waiting for the
                step it is already on, so reordering is safe — but if you <em>delete</em> the step
                someone is waiting for, they move on to their next unsent step instead.
              </div>
            )}

            <div className="field">
              <span>Message sequence *</span>
              <div className="muted small" style={{ marginBottom: 8 }}>
                Steps are sent in order. Each delay is measured from the previous step.
              </div>

              {form.steps.map((s, i) => {
                const tplBody = s.templateId ? templateBodies[s.templateId] : undefined;
                return (
                  <div key={s._id || `new-${i}`} className="card step-card">
                    <div className="step-head">
                      <strong>Step {i + 1}</strong>
                      <span className="muted small">{delayLabel(s, i)}</span>
                      <span className="step-actions">
                        <button
                          type="button" className="btn btn-sm" onClick={() => moveStep(i, -1)}
                          disabled={i === 0} title="Move this step earlier"
                        >↑</button>
                        <button
                          type="button" className="btn btn-sm" onClick={() => moveStep(i, 1)}
                          disabled={i === form.steps.length - 1} title="Move this step later"
                        >↓</button>
                        <button
                          type="button" className="btn btn-sm btn-danger" onClick={() => removeStep(i)}
                          disabled={form.steps.length === 1} title="Remove this step"
                        >Remove</button>
                      </span>
                    </div>

                    <div className="step-fields">
                      <label className="field step-delay">
                        <span className="small">{i === 0 ? 'Wait before' : 'Delay after previous'}</span>
                        <input
                          type="number" min="0" value={s.delayValue}
                          onChange={(e) => updateStep(i, { delayValue: e.target.value })}
                        />
                      </label>
                      <label className="field step-unit">
                        <span className="small">Unit</span>
                        <select
                          className="input" value={s.delayUnit}
                          onChange={(e) => updateStep(i, { delayUnit: e.target.value })}
                        >
                          {DELAY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                        </select>
                      </label>
                      <label className="field step-template">
                        <span className="small">Template</span>
                        <select
                          className="input" value={s.templateId}
                          onChange={(e) => { updateStep(i, { templateId: e.target.value }); loadTemplateBody(e.target.value); }}
                        >
                          <option value="">No template / Custom message</option>
                          {templates.map((t) => <option key={t._id} value={t._id}>{t.name}</option>)}
                        </select>
                      </label>
                    </div>

                    {s.templateId ? (
                      <div>
                        <div className="alert alert-info small" style={{ whiteSpace: 'pre-wrap' }}>
                          {tplBody || (tplBody === '' ? '(template unavailable)' : 'Loading template…')}
                        </div>
                        <div className="muted small">
                          Merge fields like {'{{first_name}}'} are filled in per contact when sent.
                        </div>
                      </div>
                    ) : (
                      <label className="field step-body">
                        <span className="small">Message body *</span>
                        <textarea
                          rows={3}
                          placeholder="Message body — merge fields like {{first_name}} are supported"
                          value={s.body}
                          onChange={(e) => updateStep(i, { body: e.target.value })}
                        />
                        <SmsCounter text={s.body} />
                      </label>
                    )}
                  </div>
                );
              })}

              <button type="button" className="btn btn-sm" onClick={addStep}>
                + Add step
              </button>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={closeModal}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save campaign'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {confirm && (
        <ConfirmDialog
          title={
            confirm.type !== 'single'
              ? `Delete all ${pagination.total} campaigns?`
              : confirm.force
                ? 'Delete this campaign AND its enrollments?'
                : 'Delete campaign?'
          }
          confirmLabel={confirm.type === 'single' ? (confirm.force ? 'Delete anyway' : 'Delete') : 'Delete All'}
          busy={deleting}
          onConfirm={performDelete}
          onClose={() => setConfirm(null)}
          message={
            confirm.type === 'single' ? (
              confirm.force ? (
                <div>
                  <p>
                    <strong>{confirm.campaign.name}</strong> has{' '}
                    <strong>{confirm.enrollmentCount} enrollment record{confirm.enrollmentCount === 1 ? '' : 's'}</strong>
                    {confirm.liveEnrollmentCount > 0 && <> ({confirm.liveEnrollmentCount} still in flight)</>}.
                    Deleting the campaign deletes that history too.
                  </p>
                  <p className="muted small">
                    If you only want to stop it sending, close this and set the campaign to
                    <strong> paused</strong> instead. Contacts and SMS history are always kept.
                    This cannot be undone.
                  </p>
                </div>
              ) : (
                <p>
                  Delete <strong>{confirm.campaign.name}</strong>? Contacts and message history are kept.
                  This cannot be undone.
                </p>
              )
            ) : (
              <p>
                This will permanently delete <strong>all {pagination.total} campaigns</strong> and their
                enrollment records. Contacts and message history are kept. This action cannot be undone.
              </p>
            )
          }
        />
      )}
    </div>
  );
}

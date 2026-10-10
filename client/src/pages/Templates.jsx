// Template management: list, create/edit (with merge-field preview), delete.
import { useEffect, useState, useCallback } from 'react';
import api from '../services/api';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import SmsCounter from '../components/SmsCounter';

const emptyForm = { name: '', description: '', body: '' };

const TemplatesIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
    <line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" />
  </svg>
);

export default function Templates() {
  const [templates, setTemplates] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, pages: 0 });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [modal, setModal] = useState({ open: false, mode: 'create', id: null });
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  // Live preview state
  const [preview, setPreview] = useState('');
  const [mergeFields, setMergeFields] = useState([]);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/templates', {
        params: { search: search || undefined, page, limit: 20 },
      });
      setTemplates(data.data);
      setPagination(data.pagination);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  }, [search, page]);

  useEffect(() => {
    const t = setTimeout(fetchTemplates, 300);
    return () => clearTimeout(t);
  }, [fetchTemplates]);

  const openCreate = () => {
    setForm(emptyForm);
    setFormError('');
    setPreview('');
    setMergeFields([]);
    setModal({ open: true, mode: 'create', id: null });
  };

  const openEdit = (t) => {
    setForm({ name: t.name || '', description: t.description || '', body: t.body || '' });
    setFormError('');
    setPreview('');
    setMergeFields([]);
    setModal({ open: true, mode: 'edit', id: t._id });
  };

  const closeModal = () => setModal({ open: false, mode: 'create', id: null });

  const runPreview = async () => {
    try {
      const { data } = await api.post('/templates/preview', {
        body: form.body,
        // Sample data derived from field names so the preview is meaningful.
        data: { first_name: 'Alex', last_name: 'Rivera', company: 'Webinfoys' },
      });
      setPreview(data.rendered);
      setMergeFields(data.mergeFields);
    } catch (err) {
      setFormError(err.response?.data?.message || 'Preview failed');
    }
  };

  const saveTemplate = async (e) => {
    e.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      if (modal.mode === 'create') {
        await api.post('/templates', form);
      } else {
        await api.put(`/templates/${modal.id}`, form);
      }
      closeModal();
      fetchTemplates();
    } catch (err) {
      setFormError(err.response?.data?.message || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  const deleteTemplate = async (t) => {
    if (!window.confirm(`Delete template "${t.name}"?`)) return;
    try {
      await api.delete(`/templates/${t._id}`);
      fetchTemplates();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to delete template');
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Templates</h1>
          <div className="page-sub">Reusable message bodies with merge fields.</div>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>
          + New template
        </button>
      </div>

      <div className="filters">
        <input
          className="input"
          placeholder="Search templates…"
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
              <th>Description</th>
              <th>Body</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4}>
                  <Spinner label="Loading templates…" />
                </td>
              </tr>
            ) : templates.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <EmptyState
                    icon={TemplatesIcon}
                    title={search ? 'No matching templates' : 'No templates yet'}
                    hint={
                      search
                        ? 'Try a different search term.'
                        : 'Create a reusable message template with merge fields like {{first_name}}.'
                    }
                  />
                </td>
              </tr>
            ) : (
              templates.map((t) => (
                <tr key={t._id}>
                  <td>{t.name}</td>
                  <td>{t.description || <span className="muted">—</span>}</td>
                  <td className="small preview-cell">{t.body}</td>
                  <td className="row-actions">
                    <button className="btn btn-sm" onClick={() => openEdit(t)}>
                      Edit
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => deleteTemplate(t)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))
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
          title={modal.mode === 'create' ? 'New template' : 'Edit template'}
          onClose={closeModal}
        >
          <form onSubmit={saveTemplate}>
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
              <span>Body * — use merge fields like {'{{first_name}}'}</span>
              <textarea
                rows={4}
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                required
              />
            </label>

            <div className="preview-box">
              <button type="button" className="btn btn-sm" onClick={runPreview}>
                Preview
              </button>
              <div style={{ marginTop: 6 }}><SmsCounter text={form.body} /></div>
              {mergeFields.length > 0 && (
                <div className="small muted" style={{ marginTop: 6 }}>
                  Merge fields: {mergeFields.map((f) => `{{${f}}}`).join(', ')}
                </div>
              )}
              {preview && (
                <div className="alert alert-info" style={{ marginTop: 6 }}>
                  {preview}
                </div>
              )}
            </div>

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
    </div>
  );
}

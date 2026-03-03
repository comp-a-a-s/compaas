import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ContextPack } from '../types';
import {
  createContextPack,
  deleteContextPack,
  listContextPacks,
  updateContextPack,
} from '../api/client';

interface ContextPackPanelProps {
  activeProjectId?: string;
  defaultScope?: 'global' | 'project';
}

const panelStyle: CSSProperties = {
  border: '1px solid var(--tf-border)',
  borderRadius: '8px',
  backgroundColor: 'var(--tf-surface)',
  padding: '10px',
  width: '320px',
  maxWidth: '80vw',
  boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
};

export default function ContextPackPanel({
  activeProjectId = '',
  defaultScope = 'project',
}: ContextPackPanelProps) {
  const canUseProjectScope = Boolean(activeProjectId);
  const [scope, setScope] = useState<'global' | 'project'>(canUseProjectScope ? defaultScope : 'global');
  const [packs, setPacks] = useState<ContextPack[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [editingId, setEditingId] = useState('');
  const [kind, setKind] = useState<'product' | 'tech' | 'design' | 'ops' | 'constraints'>('ops');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    if (!canUseProjectScope && scope === 'project') {
      setScope('global');
    }
  }, [canUseProjectScope, scope]);

  const loadPacks = useCallback(async () => {
    setLoading(true);
    const data = await listContextPacks({
      scope,
      project_id: scope === 'project' ? activeProjectId : undefined,
    });
    setPacks(data);
    setLoading(false);
  }, [activeProjectId, scope]);

  useEffect(() => {
    void loadPacks();
  }, [loadPacks]);

  const resetForm = () => {
    setEditingId('');
    setKind('ops');
    setTitle('');
    setContent('');
    setEnabled(true);
    setPinned(true);
  };

  const scopeLabel = useMemo(() => {
    return scope === 'project' ? 'Project Packs' : 'Global Packs';
  }, [scope]);

  const handleSubmit = async () => {
    if (!title.trim() || !content.trim()) {
      setStatus('Title and content are required.');
      return;
    }
    setSaving(true);
    setStatus(editingId ? 'Saving pack...' : 'Creating pack...');
    if (editingId) {
      const result = await updateContextPack(editingId, {
        kind,
        title: title.trim(),
        content: content.trim(),
        enabled,
        pinned,
      });
      if (!result.ok) {
        setStatus(result.detail || 'Failed to update context pack.');
      } else {
        setStatus('Context pack updated.');
        resetForm();
        await loadPacks();
      }
    } else {
      const result = await createContextPack({
        scope,
        project_id: scope === 'project' ? activeProjectId : undefined,
        kind,
        title: title.trim(),
        content: content.trim(),
        enabled,
        pinned,
      });
      if (!result.ok) {
        setStatus(result.detail || 'Failed to create context pack.');
      } else {
        setStatus('Context pack created.');
        resetForm();
        await loadPacks();
      }
    }
    setSaving(false);
  };

  const handleEdit = (pack: ContextPack) => {
    setEditingId(pack.id);
    const nextKind = String(pack.kind || 'ops').toLowerCase();
    if (nextKind === 'product' || nextKind === 'tech' || nextKind === 'design' || nextKind === 'ops' || nextKind === 'constraints') {
      setKind(nextKind);
    } else {
      setKind('ops');
    }
    setTitle(pack.title || '');
    setContent(pack.content || '');
    setEnabled(Boolean(pack.enabled));
    setPinned(Boolean(pack.pinned));
    setStatus('Editing existing context pack.');
  };

  const handleDelete = async (packId: string) => {
    setSaving(true);
    const result = await deleteContextPack(packId);
    setSaving(false);
    if (!result.ok) {
      setStatus(result.detail || 'Failed to delete context pack.');
      return;
    }
    if (editingId === packId) resetForm();
    setStatus('Context pack deleted.');
    await loadPacks();
  };

  const handleQuickToggle = async (pack: ContextPack, field: 'enabled' | 'pinned', value: boolean) => {
    const result = await updateContextPack(pack.id, { [field]: value });
    if (!result.ok) {
      setStatus(result.detail || `Failed to update ${field}.`);
      return;
    }
    setPacks((prev) => prev.map((item) => (item.id === pack.id ? { ...item, [field]: value } : item)));
  };

  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <p style={{ margin: 0, fontSize: '12px', fontWeight: 600, color: 'var(--tf-text)' }}>Context Packs</p>
        <button
          type="button"
          onClick={() => { void loadPacks(); }}
          style={{ border: '1px solid var(--tf-border)', background: 'transparent', borderRadius: '5px', fontSize: '11px', color: 'var(--tf-text-secondary)', cursor: 'pointer', padding: '2px 6px' }}
        >
          Refresh
        </button>
      </div>

      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
        <button
          type="button"
          onClick={() => setScope('project')}
          disabled={!canUseProjectScope}
          style={{
            flex: 1,
            border: '1px solid var(--tf-border)',
            backgroundColor: scope === 'project' ? 'color-mix(in srgb, var(--tf-accent-blue) 16%, transparent)' : 'transparent',
            color: scope === 'project' ? 'var(--tf-accent-blue)' : 'var(--tf-text-secondary)',
            borderRadius: '6px',
            fontSize: '11px',
            padding: '4px 6px',
            cursor: canUseProjectScope ? 'pointer' : 'not-allowed',
          }}
        >
          Project
        </button>
        <button
          type="button"
          onClick={() => setScope('global')}
          style={{
            flex: 1,
            border: '1px solid var(--tf-border)',
            backgroundColor: scope === 'global' ? 'color-mix(in srgb, var(--tf-accent-blue) 16%, transparent)' : 'transparent',
            color: scope === 'global' ? 'var(--tf-accent-blue)' : 'var(--tf-text-secondary)',
            borderRadius: '6px',
            fontSize: '11px',
            padding: '4px 6px',
            cursor: 'pointer',
          }}
        >
          Global
        </button>
      </div>

      <p style={{ margin: '0 0 8px', fontSize: '11px', color: 'var(--tf-text-muted)' }}>{scopeLabel}</p>

      <div style={{ maxHeight: '150px', overflowY: 'auto', border: '1px solid var(--tf-border)', borderRadius: '6px', padding: '6px', marginBottom: '8px', backgroundColor: 'var(--tf-bg)' }}>
        {loading ? (
          <p style={{ margin: 0, fontSize: '11px', color: 'var(--tf-text-muted)' }}>Loading packs...</p>
        ) : packs.length === 0 ? (
          <p style={{ margin: 0, fontSize: '11px', color: 'var(--tf-text-muted)' }}>No packs yet.</p>
        ) : packs.map((pack) => (
          <div key={pack.id} style={{ borderBottom: '1px dashed var(--tf-border)', paddingBottom: '6px', marginBottom: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
              <button
                type="button"
                onClick={() => handleEdit(pack)}
                style={{ border: 'none', background: 'transparent', padding: 0, fontSize: '11px', color: 'var(--tf-text)', cursor: 'pointer', textAlign: 'left' }}
                title="Edit pack"
              >
                {pack.title}
              </button>
              <button
                type="button"
                onClick={() => { void handleDelete(pack.id); }}
                disabled={saving}
                style={{ border: '1px solid var(--tf-error)', background: 'transparent', borderRadius: '4px', fontSize: '10px', color: 'var(--tf-error)', cursor: 'pointer', padding: '1px 5px' }}
              >
                Delete
              </button>
            </div>
            <div style={{ display: 'flex', gap: '6px', marginTop: '4px', alignItems: 'center' }}>
              <label style={{ fontSize: '10px', color: 'var(--tf-text-muted)' }}>
                <input
                  type="checkbox"
                  checked={Boolean(pack.enabled)}
                  onChange={(e) => { void handleQuickToggle(pack, 'enabled', e.target.checked); }}
                  style={{ marginRight: '4px' }}
                />
                Enabled
              </label>
              <label style={{ fontSize: '10px', color: 'var(--tf-text-muted)' }}>
                <input
                  type="checkbox"
                  checked={Boolean(pack.pinned)}
                  onChange={(e) => { void handleQuickToggle(pack, 'pinned', e.target.checked); }}
                  style={{ marginRight: '4px' }}
                />
                Pinned
              </label>
              <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--tf-accent-blue)' }}>{pack.kind}</span>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gap: '6px' }}>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as 'product' | 'tech' | 'design' | 'ops' | 'constraints')}
          style={{ border: '1px solid var(--tf-border)', borderRadius: '6px', backgroundColor: 'var(--tf-bg)', color: 'var(--tf-text)', fontSize: '11px', padding: '4px 6px' }}
        >
          <option value="product">Product</option>
          <option value="tech">Tech</option>
          <option value="design">Design</option>
          <option value="ops">Ops</option>
          <option value="constraints">Constraints</option>
        </select>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Pack title"
          style={{ border: '1px solid var(--tf-border)', borderRadius: '6px', backgroundColor: 'var(--tf-bg)', color: 'var(--tf-text)', fontSize: '11px', padding: '4px 6px' }}
        />
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Context content"
          rows={4}
          style={{ border: '1px solid var(--tf-border)', borderRadius: '6px', backgroundColor: 'var(--tf-bg)', color: 'var(--tf-text)', fontSize: '11px', padding: '6px', resize: 'vertical' }}
        />
        <div style={{ display: 'flex', gap: '8px' }}>
          <label style={{ fontSize: '10px', color: 'var(--tf-text-muted)' }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ marginRight: '4px' }} />
            Enabled
          </label>
          <label style={{ fontSize: '10px', color: 'var(--tf-text-muted)' }}>
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} style={{ marginRight: '4px' }} />
            Pinned
          </label>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            type="button"
            onClick={() => { void handleSubmit(); }}
            disabled={saving}
            style={{ flex: 1, border: '1px solid var(--tf-accent-blue)', borderRadius: '6px', backgroundColor: 'var(--tf-accent-blue)', color: 'var(--tf-bg)', fontSize: '11px', padding: '5px 6px', cursor: 'pointer' }}
          >
            {saving ? 'Saving...' : editingId ? 'Update Pack' : 'Create Pack'}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              disabled={saving}
              style={{ border: '1px solid var(--tf-border)', borderRadius: '6px', backgroundColor: 'transparent', color: 'var(--tf-text-secondary)', fontSize: '11px', padding: '5px 6px', cursor: 'pointer' }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {status && (
        <p style={{ margin: '8px 0 0', fontSize: '11px', color: 'var(--tf-text-muted)' }}>{status}</p>
      )}
    </div>
  );
}

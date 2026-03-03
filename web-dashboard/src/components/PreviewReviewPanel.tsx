import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addReviewComment,
  createReviewSession,
  fetchReviewSession,
  listReviewSessions,
  updateReviewComment,
} from '../api/client';
import type { ReviewComment, ReviewSession } from '../types';

interface PreviewReviewPanelProps {
  projectId: string;
  initialDeploymentUrl?: string;
}

export default function PreviewReviewPanel({ projectId, initialDeploymentUrl = '' }: PreviewReviewPanelProps) {
  const [sessions, setSessions] = useState<ReviewSession[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [deploymentUrl, setDeploymentUrl] = useState(initialDeploymentUrl);
  const [route, setRoute] = useState('');
  const [elementHint, setElementHint] = useState('');
  const [note, setNote] = useState('');
  const [severity, setSeverity] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');

  const loadSessions = useCallback(async () => {
    setLoading(true);
    const data = await listReviewSessions(projectId, { limit: 50 });
    setSessions(data.sessions);
    if (!sessionId && data.sessions.length > 0) {
      setSessionId(data.sessions[0].id);
    }
    setLoading(false);
  }, [projectId, sessionId]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const loadComments = useCallback(async () => {
    if (!sessionId) {
      setComments([]);
      return;
    }
    const payload = await fetchReviewSession(sessionId);
    setComments(payload.comments || []);
  }, [sessionId]);

  useEffect(() => {
    void loadComments();
  }, [loadComments]);

  const selectedSession = useMemo(() => sessions.find((entry) => entry.id === sessionId) || null, [sessions, sessionId]);

  const handleCreateSession = async () => {
    if (!deploymentUrl.trim()) {
      setStatus('Deployment URL is required.');
      return;
    }
    setSaving(true);
    const result = await createReviewSession(projectId, {
      deployment_url: deploymentUrl.trim(),
      source: 'vercel_preview',
      created_by: 'chairman',
    });
    setSaving(false);
    if (!result.ok) {
      setStatus(result.detail || 'Failed to create review session.');
      return;
    }
    const created = result.data?.session;
    setStatus('Review session created.');
    await loadSessions();
    if (created?.id) setSessionId(created.id);
  };

  const handleAddComment = async () => {
    if (!sessionId) {
      setStatus('Select a review session first.');
      return;
    }
    if (!note.trim()) {
      setStatus('Comment note is required.');
      return;
    }
    setSaving(true);
    const result = await addReviewComment(sessionId, {
      route: route.trim(),
      element_hint: elementHint.trim(),
      note: note.trim(),
      severity,
      status: 'open',
      author: 'chairman',
    });
    setSaving(false);
    if (!result.ok) {
      setStatus(result.detail || 'Failed to add comment.');
      return;
    }
    setStatus('Review comment added.');
    setNote('');
    setRoute('');
    setElementHint('');
    await loadComments();
    await loadSessions();
  };

  const toggleResolved = async (comment: ReviewComment) => {
    const nextStatus = String(comment.status || 'open') === 'resolved' ? 'open' : 'resolved';
    const result = await updateReviewComment(comment.id, { status: nextStatus });
    if (!result.ok) {
      setStatus(result.detail || 'Failed to update comment status.');
      return;
    }
    await loadComments();
    await loadSessions();
  };

  return (
    <div style={{ border: '1px solid var(--tf-border)', borderRadius: '8px', backgroundColor: 'var(--tf-surface-raised)', padding: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px' }}>
        <p style={{ margin: 0, fontSize: '12px', fontWeight: 600, color: 'var(--tf-text)' }}>Preview Reviews</p>
        <button
          type="button"
          onClick={() => { void loadSessions(); }}
          style={{ border: '1px solid var(--tf-border)', background: 'transparent', borderRadius: '5px', fontSize: '11px', color: 'var(--tf-text-secondary)', cursor: 'pointer', padding: '2px 6px' }}
        >
          Refresh
        </button>
      </div>

      <div style={{ display: 'grid', gap: '6px', marginBottom: '10px' }}>
        <input
          value={deploymentUrl}
          onChange={(e) => setDeploymentUrl(e.target.value)}
          placeholder="https://preview-url.vercel.app"
          style={{ border: '1px solid var(--tf-border)', borderRadius: '6px', backgroundColor: 'var(--tf-bg)', color: 'var(--tf-text)', fontSize: '11px', padding: '5px 6px' }}
        />
        <button
          type="button"
          onClick={() => { void handleCreateSession(); }}
          disabled={saving}
          style={{ border: '1px solid var(--tf-accent-blue)', borderRadius: '6px', backgroundColor: 'var(--tf-accent-blue)', color: 'var(--tf-bg)', fontSize: '11px', padding: '5px 6px', cursor: 'pointer' }}
        >
          {saving ? 'Creating...' : 'Start Review Session'}
        </button>
      </div>

      <div style={{ marginBottom: '8px' }}>
        <label style={{ display: 'block', marginBottom: '4px', fontSize: '11px', color: 'var(--tf-text-muted)' }}>Session</label>
        <select
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          style={{ width: '100%', border: '1px solid var(--tf-border)', borderRadius: '6px', backgroundColor: 'var(--tf-bg)', color: 'var(--tf-text)', fontSize: '11px', padding: '5px 6px' }}
        >
          <option value="">{loading ? 'Loading sessions...' : 'Select review session'}</option>
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {session.created_at ? new Date(session.created_at).toLocaleString() : session.id} • unresolved {session.counts?.unresolved ?? 0}
            </option>
          ))}
        </select>
      </div>

      {selectedSession && (
        <a href={selectedSession.deployment_url} target="_blank" rel="noreferrer" style={{ fontSize: '11px', color: 'var(--tf-accent-blue)', textDecoration: 'underline' }}>
          Open Preview: {selectedSession.deployment_url}
        </a>
      )}

      <div style={{ display: 'grid', gap: '6px', marginTop: '10px' }}>
        <input
          value={route}
          onChange={(e) => setRoute(e.target.value)}
          placeholder="Route (optional), e.g. /checkout"
          style={{ border: '1px solid var(--tf-border)', borderRadius: '6px', backgroundColor: 'var(--tf-bg)', color: 'var(--tf-text)', fontSize: '11px', padding: '5px 6px' }}
        />
        <input
          value={elementHint}
          onChange={(e) => setElementHint(e.target.value)}
          placeholder="Element hint (optional), e.g. Buy button"
          style={{ border: '1px solid var(--tf-border)', borderRadius: '6px', backgroundColor: 'var(--tf-bg)', color: 'var(--tf-text)', fontSize: '11px', padding: '5px 6px' }}
        />
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value as 'low' | 'medium' | 'high' | 'critical')}
          style={{ border: '1px solid var(--tf-border)', borderRadius: '6px', backgroundColor: 'var(--tf-bg)', color: 'var(--tf-text)', fontSize: '11px', padding: '5px 6px' }}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Add structured feedback"
          style={{ border: '1px solid var(--tf-border)', borderRadius: '6px', backgroundColor: 'var(--tf-bg)', color: 'var(--tf-text)', fontSize: '11px', padding: '6px', resize: 'vertical' }}
        />
        <button
          type="button"
          onClick={() => { void handleAddComment(); }}
          disabled={saving || !sessionId}
          style={{ border: '1px solid var(--tf-border)', borderRadius: '6px', backgroundColor: 'transparent', color: 'var(--tf-text-secondary)', fontSize: '11px', padding: '5px 6px', cursor: 'pointer' }}
        >
          {saving ? 'Saving...' : 'Add Comment'}
        </button>
      </div>

      <div style={{ marginTop: '10px', maxHeight: '140px', overflowY: 'auto', border: '1px solid var(--tf-border)', borderRadius: '6px', backgroundColor: 'var(--tf-bg)', padding: '6px' }}>
        {comments.length === 0 ? (
          <p style={{ margin: 0, fontSize: '11px', color: 'var(--tf-text-muted)' }}>No comments yet.</p>
        ) : comments.map((comment) => (
          <div key={comment.id} style={{ borderBottom: '1px dashed var(--tf-border)', paddingBottom: '6px', marginBottom: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
              <span style={{ fontSize: '10px', color: 'var(--tf-accent-blue)' }}>{comment.severity}</span>
              <button
                type="button"
                onClick={() => { void toggleResolved(comment); }}
                style={{ border: '1px solid var(--tf-border)', borderRadius: '4px', backgroundColor: 'transparent', color: 'var(--tf-text-secondary)', fontSize: '10px', padding: '1px 5px', cursor: 'pointer' }}
              >
                {String(comment.status || 'open') === 'resolved' ? 'Reopen' : 'Resolve'}
              </button>
            </div>
            <p style={{ margin: '4px 0 0', fontSize: '11px', color: 'var(--tf-text-secondary)', whiteSpace: 'pre-wrap' }}>{comment.note}</p>
            {(comment.route || comment.element_hint) && (
              <p style={{ margin: '4px 0 0', fontSize: '10px', color: 'var(--tf-text-muted)' }}>
                {comment.route ? `route: ${comment.route}` : ''}{comment.route && comment.element_hint ? ' • ' : ''}{comment.element_hint ? `element: ${comment.element_hint}` : ''}
              </p>
            )}
          </div>
        ))}
      </div>

      {status && (
        <p style={{ margin: '8px 0 0', fontSize: '11px', color: 'var(--tf-text-muted)' }}>{status}</p>
      )}
    </div>
  );
}

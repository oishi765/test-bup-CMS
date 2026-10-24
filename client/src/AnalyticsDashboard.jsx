import { useState, useEffect } from 'react';
import './certificates.css';

const API = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

function ProgressBar({ label, value, max, color = '#28734c' }) {
  const percentage = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="bar-metric-row">
      <span className="bar-metric-label" title={label}>
        {label}
      </span>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${percentage}%`, background: color }} />
      </div>
      <span className="bar-metric-val">{value}</span>
    </div>
  );
}

export default function AnalyticsDashboard() {
  const [conferences, setConferences] = useState([]);
  const [selectedConfId, setSelectedConfId] = useState('');
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadConferences = async () => {
    try {
      const res = await fetch(`${API}/api/conferences?limit=100`, { credentials: 'include' });
      if (res.ok) {
        const json = await res.json();
        const confs = json.data || [];
        setConferences(confs);
        if (confs.length > 0 && !selectedConfId) {
          setSelectedConfId(confs[0].id);
        }
      }
    } catch {
      // ignore
    }
  };

  const loadAnalytics = async (confId) => {
    if (!confId) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/admin/conferences/${confId}/analytics`, { credentials: 'include' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error?.message || 'Could not load analytics');
      }
      setAnalytics(json.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConferences();
  }, []);

  useEffect(() => {
    if (selectedConfId) {
      loadAnalytics(selectedConfId);
    }
  }, [selectedConfId]);

  const triggerExport = (endpoint, filename) => {
    const url = `${API}/api/admin/conferences/${selectedConfId}/reports/${endpoint}`;
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const sub = analytics?.submissions || {};
  const rev = analytics?.reviews || {};
  const reg = analytics?.registrations || {};
  const pay = analytics?.payments || {};
  const att = analytics?.attendance || {};
  const cert = analytics?.certificates || {};

  return (
    <div className="analytics-container">
      <div className="page-title" style={{ padding: '20px 0' }}>
        <p className="eyebrow">INTELLIGENCE & REPORTING</p>
        <h1>Conference Analytics</h1>
        <p className="page-lead">
          Real-time PostgreSQL metrics across submissions, peer reviews, attendee registrations, revenue, attendance check-ins, and certificate issuance.
        </p>
      </div>

      <div className="analytics-export-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <label htmlFor="conf-selector" style={{ fontWeight: 600, fontSize: '0.875rem' }}>
            Conference:
          </label>
          <select
            id="conf-selector"
            value={selectedConfId}
            onChange={(e) => setSelectedConfId(e.target.value)}
            style={{
              padding: '0.5rem 0.75rem',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              fontSize: '0.875rem',
              minWidth: '280px',
              background: '#fff',
            }}
          >
            {conferences.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="button button-outline"
            style={{ padding: '6px 12px', fontSize: '11px', minHeight: 'unset' }}
            onClick={() => loadAnalytics(selectedConfId)}
            disabled={loading}
          >
            Refresh ⟳
          </button>
        </div>

        <div className="export-btns">
          <button
            type="button"
            className="button button-outline"
            style={{ padding: '6px 12px', fontSize: '11px' }}
            onClick={() => triggerExport('registrations/csv', 'registrations.csv')}
          >
            Registrations CSV ⤓
          </button>
          <button
            type="button"
            className="button button-outline"
            style={{ padding: '6px 12px', fontSize: '11px' }}
            onClick={() => triggerExport('submissions/csv', 'submissions.csv')}
          >
            Submissions CSV ⤓
          </button>
          <button
            type="button"
            className="button button-outline"
            style={{ padding: '6px 12px', fontSize: '11px' }}
            onClick={() => triggerExport('attendance/csv', 'attendance.csv')}
          >
            Attendance CSV ⤓
          </button>
          <button
            type="button"
            className="button button-green"
            style={{ padding: '6px 14px', fontSize: '11px' }}
            onClick={() => triggerExport('summary/pdf', 'conference-executive-summary.pdf')}
          >
            Executive Summary PDF ⤓
          </button>
        </div>
      </div>

      {loading ? (
        <div className="state-box" role="status">
          <span className="spinner" /> Querying conference database metrics…
        </div>
      ) : error ? (
        <div className="state-box state-error" role="alert">
          <strong>Could not retrieve metrics</strong>
          <p>{error}</p>
        </div>
      ) : !analytics ? null : (
        <>
          {/* Top KPI Cards */}
          <div className="kpi-grid">
            <div className="kpi-card">
              <span className="kpi-title">Registrations</span>
              <span className="kpi-value">{reg.confirmed || 0}</span>
              <span className="kpi-sub">
                {reg.total || 0} total · {reg.capacity_percentage || 0}% capacity
              </span>
            </div>

            <div className="kpi-card">
              <span className="kpi-title">Verified Revenue</span>
              <span className="kpi-value" style={{ color: '#15803d' }}>
                {pay.total_revenue_bdt ? `BDT ${pay.total_revenue_bdt.toLocaleString()}` : `BDT 0`}
              </span>
              <span className="kpi-sub">
                {pay.verified_count || 0} verified · {pay.pending_count || 0} pending review
              </span>
            </div>

            <div className="kpi-card">
              <span className="kpi-title">Paper Submissions</span>
              <span className="kpi-value">{sub.total || 0}</span>
              <span className="kpi-sub">
                {sub.accepted || 0} accepted · {sub.in_review || 0} in review
              </span>
            </div>

            <div className="kpi-card">
              <span className="kpi-title">Peer Reviews</span>
              <span className="kpi-value">{rev.completed || 0}</span>
              <span className="kpi-sub">
                Avg score: {rev.average_score || 'N/A'} · {rev.overdue || 0} overdue
              </span>
            </div>

            <div className="kpi-card">
              <span className="kpi-title">Attendees Checked In</span>
              <span className="kpi-value">{att.unique_attendees || 0}</span>
              <span className="kpi-sub">
                {att.total_checkins || 0} total session check-ins
              </span>
            </div>

            <div className="kpi-card">
              <span className="kpi-title">Certificates Issued</span>
              <span className="kpi-value">{cert.total_issued || 0}</span>
              <span className="kpi-sub">
                {cert.active || 0} active · {cert.revoked || 0} revoked
              </span>
            </div>
          </div>

          {/* Detailed Breakdown Charts */}
          <div className="analytics-section-title">Module Breakdown & Distribution</div>

          <div className="chart-grid">
            {/* Submissions breakdown */}
            <div className="chart-card">
              <h3>Submissions by Editorial State</h3>
              <ProgressBar label="Accepted" value={sub.accepted || 0} max={sub.total || 1} color="#16a34a" />
              <ProgressBar label="In Review" value={sub.in_review || 0} max={sub.total || 1} color="#0284c7" />
              <ProgressBar label="Revisions" value={sub.revision_requested || 0} max={sub.total || 1} color="#eab308" />
              <ProgressBar label="Submitted" value={sub.submitted || 0} max={sub.total || 1} color="#64748b" />
              <ProgressBar label="Rejected" value={sub.rejected || 0} max={sub.total || 1} color="#dc2626" />
              <ProgressBar label="Camera Ready" value={sub.camera_ready || 0} max={sub.total || 1} color="#059669" />
              <ProgressBar label="Finalized" value={sub.finalized || 0} max={sub.total || 1} color="#047857" />
            </div>

            {/* Registrations & Capacity */}
            <div className="chart-card">
              <h3>Registration & Venue Capacity</h3>
              <ProgressBar label="Confirmed" value={reg.confirmed || 0} max={reg.capacity || reg.total || 1} color="#16a34a" />
              <ProgressBar label="Pending Payment" value={reg.pending || 0} max={reg.capacity || reg.total || 1} color="#f59e0b" />
              <ProgressBar label="Cancelled" value={reg.cancelled || 0} max={reg.capacity || reg.total || 1} color="#94a3b8" />
              <div style={{ marginTop: '1.25rem', padding: '0.75rem', background: '#f8fafc', borderRadius: '6px', fontSize: '0.825rem' }}>
                <strong>Capacity Utilization:</strong> {reg.capacity_percentage || 0}% of {reg.capacity || 'Unlimited'} maximum seats allocated.
              </div>
            </div>

            {/* Presentations & Attendance */}
            <div className="chart-card">
              <h3>Presentations & Attendance Progress</h3>
              <ProgressBar label="Completed" value={att.presentations_completed || 0} max={att.presentations_total || 1} color="#16a34a" />
              <ProgressBar label="Scheduled" value={att.presentations_scheduled || 0} max={att.presentations_total || 1} color="#0284c7" />
              <ProgressBar label="Absent" value={att.presentations_absent || 0} max={att.presentations_total || 1} color="#ef4444" />
              <ProgressBar label="Rescheduled" value={att.presentations_rescheduled || 0} max={att.presentations_total || 1} color="#f59e0b" />
              <div style={{ marginTop: '1.25rem', padding: '0.75rem', background: '#f8fafc', borderRadius: '6px', fontSize: '0.825rem' }}>
                <strong>Total Attendance Records:</strong> {att.total_checkins || 0} across all conference sessions.
              </div>
            </div>

            {/* Certificates by Type */}
            <div className="chart-card">
              <h3>Certificates Issued by Category</h3>
              <ProgressBar label="Attendees" value={cert.by_type?.attendee || 0} max={cert.total_issued || 1} color="#28734c" />
              <ProgressBar label="Presenters" value={cert.by_type?.presenter || 0} max={cert.total_issued || 1} color="#0284c7" />
              <ProgressBar label="Authors" value={cert.by_type?.author || 0} max={cert.total_issued || 1} color="#d97706" />
              <ProgressBar label="Reviewers" value={cert.by_type?.reviewer || 0} max={cert.total_issued || 1} color="#7c3aed" />
              <ProgressBar label="Organizers" value={cert.by_type?.organizer || 0} max={cert.total_issued || 1} color="#db2777" />
            </div>
          </div>

          <div style={{ fontSize: '0.8rem', color: '#94a3b8', textAlign: 'right', marginTop: '1rem' }}>
            Report timestamp: {new Date(analytics.generated_at).toLocaleString()}
          </div>
        </>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import './scheduling.css';

const API = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

export default function CheckInPage({ user }) {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('sessionId') || '';
  const token = params.get('token') || '';

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successData, setSuccessData] = useState(null);

  useEffect(() => {
    // If authenticated and has token and session, auto-trigger check-in
    if (user && sessionId && token && !successData && !error) {
      performCheckIn();
    }
  }, [user, sessionId, token]);

  async function performCheckIn() {
    setLoading(true);
    setError('');
    try {
      const csrfRes = await fetch(`${API}/api/auth/csrf`, { credentials: 'include' });
      const csrfData = await csrfRes.json();
      if (!csrfRes.ok) throw new Error(csrfData?.error?.message || 'Could not verify CSRF.');

      const res = await fetch(`${API}/api/sessions/${sessionId}/check-in`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfData.data.csrfToken,
        },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Check-in failed.');

      setSuccessData(data.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (!sessionId) {
    return (
      <div className="schedule-container" style={{ textAlign: 'center', padding: '3rem 1rem' }}>
        <p className="eyebrow">ATTENDANCE CHECK-IN</p>
        <h1>Invalid Session Link</h1>
        <p className="page-lead">Session identifier is missing from this check-in link.</p>
        <a href="/schedule" className="button button-green">
          View Conference Schedule →
        </a>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="schedule-container" style={{ textAlign: 'center', padding: '3rem 1rem', maxWidth: '600px' }}>
        <p className="eyebrow">ATTENDANCE CHECK-IN</p>
        <h1>Sign In to Confirm Attendance</h1>
        <p className="page-lead">
          Please log into your BUP conference account to record your attendance.
        </p>
        <div style={{ marginTop: '2rem' }}>
          <a
            href={`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`}
            className="button button-green button-full"
          >
            Sign In with Account →
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="schedule-container" style={{ textAlign: 'center', padding: '3rem 1rem', maxWidth: '600px' }}>
      <p className="eyebrow">VERIFIED SESSION ATTENDANCE</p>
      <h1>Session Check-In</h1>

      {loading && (
        <div className="state-box" style={{ marginTop: '2rem' }}>
          <span className="spinner"/> Recording your attendance...
        </div>
      )}

      {error && (
        <div className="state-box state-error" role="alert" style={{ marginTop: '2rem' }}>
          <strong>Check-in failed</strong>
          <p>{error}</p>
          <button type="button" className="button button-outline" onClick={performCheckIn} style={{ marginTop: '1rem' }}>
            Try Again
          </button>
        </div>
      )}

      {successData && (
        <div className="form-message success" style={{ padding: '2rem', marginTop: '2rem' }}>
          <h2 style={{ color: '#15803d', marginTop: 0 }}>✓ Attendance Recorded!</h2>
          <p style={{ fontSize: '1.05rem', margin: '0.5rem 0' }}>
            <strong>{successData.sessionTitle}</strong>
          </p>
          <p className="muted" style={{ marginBottom: '1.5rem' }}>
            Role: <strong className="capitalize">{successData.record.attendance_role}</strong> · Method: QR Code
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
            <a href="/schedule" className="button button-green">
              View Schedule
            </a>
            <a href="/dashboard" className="button button-outline">
              My Dashboard
            </a>
          </div>
        </div>
      )}

      {!loading && !error && !successData && (
        <div style={{ marginTop: '2rem' }}>
          <p>Ready to check into this session as <strong>{user.fullName}</strong> ({user.email}).</p>
          <button type="button" className="button button-green" onClick={performCheckIn} style={{ marginTop: '1rem' }}>
            Confirm My Attendance Now
          </button>
        </div>
      )}
    </div>
  );
}

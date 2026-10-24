import { useEffect, useState } from 'react';
import './scheduling.css';

const API = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

export default function ChairWorkspace() {
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState(
    new URLSearchParams(window.location.search).get('sessionId') || ''
  );
  const [sessionDetail, setSessionDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Status editing modal
  const [editingSlot, setEditingSlot] = useState(null);
  const [statusVal, setStatusVal] = useState('completed');
  const [notesVal, setNotesVal] = useState('');

  // Manual Check-in
  const [selectedAttendeeId, setSelectedAttendeeId] = useState('');
  const [attendeeRole, setAttendeeRole] = useState('participant');

  // QR Code Token State
  const [qrTokenData, setQrTokenData] = useState(null);
  const [showQrModal, setShowQrModal] = useState(false);

  useEffect(() => {
    loadChairSessions();
  }, []);

  useEffect(() => {
    if (selectedSessionId) {
      loadSessionDetail(selectedSessionId);
    }
  }, [selectedSessionId]);

  async function getCsrf() {
    const res = await fetch(`${API}/api/auth/csrf`, { credentials: 'include' });
    const data = await res.json();
    return data.data.csrfToken;
  }

  async function loadChairSessions() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/chair/sessions`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed to load assigned sessions.');
      setSessions(data.data || []);
      if (!selectedSessionId && data.data?.length > 0) {
        setSelectedSessionId(data.data[0].id);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadSessionDetail(sessionId) {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/chair/sessions/${sessionId}`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed to load session details.');
      setSessionDetail(data.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Update presentation status
  async function handleStatusSubmit(e) {
    e.preventDefault();
    if (!editingSlot) return;
    setError('');
    setSuccess('');
    try {
      const csrf = await getCsrf();
      const res = await fetch(`${API}/api/chair/sessions/${selectedSessionId}/slots/${editingSlot.id}/status`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ status: statusVal, chairNotes: notesVal.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed to update presentation status.');

      setSuccess('Presentation status updated.');
      setEditingSlot(null);
      loadSessionDetail(selectedSessionId);
    } catch (err) {
      setError(err.message);
    }
  }

  // Manual Check-in by Chair
  async function handleManualCheckIn(e) {
    e.preventDefault();
    if (!selectedAttendeeId) return;
    setError('');
    setSuccess('');
    try {
      const csrf = await getCsrf();
      const res = await fetch(`${API}/api/chair/sessions/${selectedSessionId}/attendance`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ userId: selectedAttendeeId, attendanceRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed to record check-in.');

      setSuccess('Attendee checked in successfully.');
      setSelectedAttendeeId('');
      loadSessionDetail(selectedSessionId);
    } catch (err) {
      setError(err.message);
    }
  }

  // Generate Rotating QR Code Token
  async function handleGenerateQr() {
    setError('');
    setSuccess('');
    try {
      const csrf = await getCsrf();
      const res = await fetch(`${API}/api/sessions/${selectedSessionId}/check-in-token`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed to generate check-in token.');

      setQrTokenData(data.data);
      setShowQrModal(true);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="schedule-container">
      <div className="schedule-header">
        <p className="eyebrow">SESSION CHAIR WORKSPACE</p>
        <h1>Session Chair Dashboard</h1>
        <p className="page-lead">
          Manage presentations in real-time, record presentation outcomes (completed, absent, cancelled), and verify attendee attendance.
        </p>

        {sessions.length > 0 && (
          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <label style={{ fontWeight: 600 }}>Assigned Session:</label>
            <select
              value={selectedSessionId}
              onChange={(e) => setSelectedSessionId(e.target.value)}
              style={{ padding: '0.4rem 0.8rem', borderRadius: '4px', border: '1px solid #cbd5e1' }}
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} ({s.room}) – {s.presentation_count} papers
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {error && <div className="state-box state-error" role="alert"><p>{error}</p></div>}
      {success && <div className="form-message success" role="status"><p>{success}</p></div>}

      {loading && <div className="state-box"><span className="spinner"/> Loading session data...</div>}

      {!loading && sessions.length === 0 && (
        <div className="state-box empty-state">
          <h2>No sessions assigned</h2>
          <p>You have not been designated as a session chair for any conference sessions yet.</p>
        </div>
      )}

      {!loading && sessionDetail && (
        <div>
          {/* Session Overview Card */}
          <div className="session-card" style={{ borderLeftColor: '#7c3aed', marginBottom: '2rem' }}>
            <div className="session-card-header">
              <div className="session-title-group">
                <h3>{sessionDetail.session.title}</h3>
                <div className="session-meta-pills">
                  <span className="meta-pill green">Room: {sessionDetail.session.room}</span>
                  <span className="meta-pill capitalize">{sessionDetail.session.format?.replace('_', ' ')}</span>
                  <span className="meta-pill capitalize">{sessionDetail.session.session_type?.replace('_', ' ')}</span>
                  <span className="meta-pill">{sessionDetail.slots?.length || 0} Presentations</span>
                  <span className="meta-pill green">{sessionDetail.attendance?.length || 0} Attended</span>
                </div>
              </div>
              <div className="session-time-venue">
                <strong>
                  {new Date(sessionDetail.session.starts_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} –{' '}
                  {new Date(sessionDetail.session.ends_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </strong>
                <span>{new Date(sessionDetail.session.starts_at).toLocaleDateString([], { dateStyle: 'medium' })}</span>
              </div>
            </div>

            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <button type="button" className="button button-green" onClick={handleGenerateQr}>
                📱 Project / Generate Check-In QR Code
              </button>
            </div>
          </div>

          {/* Presentation Slots */}
          <div style={{ marginBottom: '2.5rem' }}>
            <h2>Paper Presentations ({sessionDetail.slots?.length || 0})</h2>
            <p className="muted" style={{ marginBottom: '1rem' }}>
              Keep track of presenters and record final presentation statuses for certificate eligibility.
            </p>

            <div className="sessions-grid">
              {sessionDetail.slots?.map((slot) => (
                <div key={slot.id} className="slot-item" style={{ padding: '1rem', flexDirection: 'column', alignItems: 'stretch' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <span className="meta-pill" style={{ marginRight: '0.5rem' }}>{slot.paper_code}</span>
                      <strong style={{ fontSize: '1.05rem' }}>{slot.paper_title}</strong>
                      <div className="slot-authors" style={{ marginTop: '0.35rem' }}>
                        Presenter: <strong>{slot.presenter_name || 'Designated Submitter'}</strong> ({slot.presenter_email || '—'})
                        {slot.authors?.length > 0 && ` · Authors: ${slot.authors.map((a) => a.fullName).join(', ')}`}
                        {slot.duration_minutes && ` · ${slot.duration_minutes} minutes`}
                      </div>
                    </div>
                    <div>
                      <span className={`status-badge status-${slot.presentation_status}`} style={{ fontSize: '0.85rem' }}>
                        {slot.presentation_status.replace('_', ' ')}
                      </span>
                    </div>
                  </div>

                  {slot.chair_notes && (
                    <div style={{ margin: '0.6rem 0', padding: '0.5rem', background: '#f8fafc', borderRadius: '4px', fontSize: '0.85rem' }}>
                      <em>Chair Notes:</em> {slot.chair_notes}
                    </div>
                  )}

                  <div style={{ marginTop: '0.75rem', display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                    <button
                      type="button"
                      className="button button-outline"
                      style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem' }}
                      onClick={() => {
                        setEditingSlot(slot);
                        setStatusVal(slot.presentation_status);
                        setNotesVal(slot.chair_notes || '');
                      }}
                    >
                      Update Presentation Status
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Attendance Roster & Manual Check-in */}
          <div>
            <h2>Attendance Roster ({sessionDetail.attendance?.length || 0})</h2>

            <div style={{ background: '#f8fafc', padding: '1rem', borderRadius: '8px', border: '1px solid #e2e8f0', marginBottom: '1.25rem' }}>
              <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '0.95rem' }}>Manual Check-In Registered Attendee</h3>
              <form onSubmit={handleManualCheckIn} style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <select
                  required
                  value={selectedAttendeeId}
                  onChange={(e) => setSelectedAttendeeId(e.target.value)}
                  style={{ flex: 2, padding: '0.5rem', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                >
                  <option value="">Select registered attendee...</option>
                  {(sessionDetail.registeredAttendees || []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.full_name} ({u.email}) - {u.institution || 'Attendee'}
                    </option>
                  ))}
                </select>

                <select
                  value={attendeeRole}
                  onChange={(e) => setAttendeeRole(e.target.value)}
                  style={{ flex: 1, padding: '0.5rem', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                >
                  <option value="participant">Participant</option>
                  <option value="presenter">Presenter</option>
                  <option value="chair">Session Chair</option>
                </select>

                <button type="submit" className="button button-green" style={{ padding: '0.5rem 1rem' }}>
                  Mark Present
                </button>
              </form>
            </div>

            {sessionDetail.attendance?.length > 0 ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Attendee</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Method</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessionDetail.attendance.map((a) => (
                      <tr key={a.id}>
                        <td><strong>{a.full_name}</strong><br/><small className="muted">{a.institution || '—'}</small></td>
                        <td>{a.email}</td>
                        <td><span className="meta-pill capitalize">{a.attendance_role}</span></td>
                        <td>{a.check_in_method === 'qr_code' ? '📱 QR Code' : a.check_in_method}</td>
                        <td>{new Date(a.checked_in_at).toLocaleTimeString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">No attendees checked in yet.</p>
            )}
          </div>
        </div>
      )}

      {/* UPDATE STATUS MODAL */}
      {editingSlot && (
        <div className="modal-backdrop" onClick={() => setEditingSlot(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Update Presentation Status</h2>
              <button type="button" className="modal-close-btn" onClick={() => setEditingSlot(null)}>&times;</button>
            </div>
            <div className="modal-body">
              <p><strong>Paper:</strong> [{editingSlot.paper_code}] {editingSlot.paper_title}</p>
              <form onSubmit={handleStatusSubmit}>
                <label style={{ display: 'block', margin: '1rem 0 0.5rem 0', fontWeight: 600 }}>
                  Presentation Outcome Status:
                  <select
                    value={statusVal}
                    onChange={(e) => setStatusVal(e.target.value)}
                    style={{ width: '100%', padding: '0.5rem', marginTop: '0.2rem', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                  >
                    <option value="scheduled">Scheduled</option>
                    <option value="in_progress">In Progress</option>
                    <option value="completed">Completed (Successfully Presented)</option>
                    <option value="absent">Absent (No-show)</option>
                    <option value="cancelled">Cancelled</option>
                    <option value="rescheduled">Rescheduled</option>
                  </select>
                </label>

                <label style={{ display: 'block', margin: '1rem 0 0.5rem 0', fontWeight: 600 }}>
                  Chair Notes / Observations:
                  <textarea
                    rows="3"
                    value={notesVal}
                    onChange={(e) => setNotesVal(e.target.value)}
                    placeholder="e.g. Completed within allotted 15 mins, active Q&A discussion."
                    style={{ width: '100%', padding: '0.5rem', marginTop: '0.2rem', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                  />
                </label>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1.5rem' }}>
                  <button type="button" className="button button-outline" onClick={() => setEditingSlot(null)}>
                    Cancel
                  </button>
                  <button type="submit" className="button button-green">
                    Save Status
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* QR MODAL */}
      {showQrModal && qrTokenData && (
        <div className="modal-backdrop" onClick={() => setShowQrModal(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Session Attendance Check-In Portal</h2>
              <button type="button" className="modal-close-btn" onClick={() => setShowQrModal(false)}>&times;</button>
            </div>
            <div className="modal-body" style={{ textAlign: 'center' }}>
              <p>Project this screen to attendees in the room so they can check in securely from their mobile devices or laptops.</p>

              <div className="qr-code-box">
                <h3>CHECK-IN CODE / PASSCODE</h3>
                <div style={{ fontSize: '1.75rem', fontWeight: 800, letterSpacing: '2px', color: '#15803d', margin: '1rem 0' }}>
                  {qrTokenData.token.slice(0, 8).toUpperCase()}
                </div>
                <p style={{ fontSize: '0.85rem', color: '#64748b' }}>
                  Valid until {new Date(qrTokenData.expiresAt).toLocaleTimeString()} (Rotating 2hr window)
                </p>
                <div className="qr-link-copy">
                  {qrTokenData.checkInUrl}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem' }}>
                <button
                  type="button"
                  className="button button-outline"
                  onClick={() => {
                    navigator.clipboard?.writeText(qrTokenData.checkInUrl);
                    alert('Check-in link copied to clipboard!');
                  }}
                >
                  Copy Check-In Link
                </button>
                <button type="button" className="button button-green" onClick={() => setShowQrModal(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

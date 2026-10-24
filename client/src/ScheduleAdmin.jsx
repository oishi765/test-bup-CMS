import { useEffect, useState } from 'react';
import './scheduling.css';

const API = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

export default function ScheduleAdmin() {
  const [conferences, setConferences] = useState([]);
  const [selectedConferenceId, setSelectedConferenceId] = useState('');
  const [activeTab, setActiveTab] = useState('sessions'); // 'sessions', 'slots', 'report'

  // Sessions list
  const [sessions, setSessions] = useState([]);
  const [tracks, setTracks] = useState([]);
  const [users, setUsers] = useState([]);
  const [eligiblePapers, setEligiblePapers] = useState([]);
  const [attendanceReport, setAttendanceReport] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Create / Edit Session Modal
  const [editingSession, setEditingSession] = useState(null);
  const [showSessionModal, setShowSessionModal] = useState(false);
  const [sessionFormData, setSessionFormData] = useState({
    title: '',
    sessionCode: '',
    description: '',
    trackId: '',
    venue: '',
    room: '',
    format: 'in_person',
    sessionType: 'paper_session',
    startsAt: '',
    endsAt: '',
    sessionChairId: '',
    isPublished: false,
  });

  // Slot Assigner Modal
  const [assigningSession, setAssigningSession] = useState(null);
  const [slotFormData, setSlotFormData] = useState({
    submissionId: '',
    presenterUserId: '',
    durationMinutes: 15,
  });

  // Load Conferences
  useEffect(() => {
    fetch(`${API}/api/conferences?limit=100`, { credentials: 'include' })
      .then((res) => res.json())
      .then((res) => {
        const list = res.data || [];
        setConferences(list);
        if (list.length > 0) setSelectedConferenceId(list[0].id);
      })
      .catch((err) => setError(err.message));
  }, []);

  // Load Sessions, Tracks, Users & Eligible Papers for selected conference
  useEffect(() => {
    if (!selectedConferenceId) return;
    refreshData();
  }, [selectedConferenceId]);

  async function refreshData() {
    setLoading(true);
    setError('');
    try {
      const [sessionsRes, tracksRes, papersRes, usersRes] = await Promise.all([
        fetch(`${API}/api/conferences/${selectedConferenceId}/schedule`, { credentials: 'include' }).then((r) => r.json()),
        fetch(`${API}/api/conferences/${selectedConferenceId}/tracks`, { credentials: 'include' }).then((r) => r.json()),
        fetch(`${API}/api/admin/conferences/${selectedConferenceId}/eligible-papers`, { credentials: 'include' }).then((r) => r.json()),
        fetch(`${API}/api/auth/admin/users`, { credentials: 'include' }).then((r) => r.json()).catch(() => ({ data: [] })),
      ]);

      setSessions(sessionsRes.data?.sessions || []);
      setTracks(tracksRes.data || []);
      setEligiblePapers(papersRes.data || []);
      setUsers(usersRes.data || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Load Attendance Report
  async function loadReport() {
    if (!selectedConferenceId) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/admin/conferences/${selectedConferenceId}/attendance-report`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed to load report.');
      setAttendanceReport(data.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (activeTab === 'report') {
      loadReport();
    }
  }, [activeTab, selectedConferenceId]);

  async function getCsrf() {
    const res = await fetch(`${API}/api/auth/csrf`, { credentials: 'include' });
    const json = await res.json();
    return json.data.csrfToken;
  }

  // Save Session (Create or Update)
  async function handleSessionSubmit(e) {
    e.preventDefault();
    setError('');
    setSuccess('');
    try {
      const csrf = await getCsrf();
      const payload = {
        title: sessionFormData.title,
        sessionCode: sessionFormData.sessionCode || undefined,
        description: sessionFormData.description || undefined,
        trackId: sessionFormData.trackId || null,
        venue: sessionFormData.venue || undefined,
        room: sessionFormData.room,
        format: sessionFormData.format,
        sessionType: sessionFormData.sessionType,
        startsAt: new Date(sessionFormData.startsAt).toISOString(),
        endsAt: new Date(sessionFormData.endsAt).toISOString(),
        sessionChairId: sessionFormData.sessionChairId || null,
        isPublished: sessionFormData.isPublished,
      };

      const url = editingSession
        ? `${API}/api/admin/conferences/${selectedConferenceId}/sessions/${editingSession.id}`
        : `${API}/api/admin/conferences/${selectedConferenceId}/sessions`;
      const method = editingSession ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed to save session.');

      setSuccess(editingSession ? 'Session updated successfully.' : 'Session created successfully.');
      setShowSessionModal(false);
      setEditingSession(null);
      refreshData();
    } catch (err) {
      setError(err.message);
    }
  }

  // Toggle Session Publish
  async function togglePublish(session) {
    try {
      const csrf = await getCsrf();
      const res = await fetch(`${API}/api/admin/conferences/${selectedConferenceId}/sessions/${session.id}/publish`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ isPublished: !session.is_published }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed to update publication status.');
      setSuccess(`Session ${session.is_published ? 'unpublished' : 'published'}.`);
      refreshData();
    } catch (err) {
      setError(err.message);
    }
  }

  // Delete Session
  async function deleteSession(sessionId) {
    if (!window.confirm('Are you sure you want to delete this session?')) return;
    try {
      const csrf = await getCsrf();
      const res = await fetch(`${API}/api/admin/conferences/${selectedConferenceId}/sessions/${sessionId}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'X-CSRF-Token': csrf },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error?.message || 'Failed to delete session.');
      }
      setSuccess('Session deleted.');
      refreshData();
    } catch (err) {
      setError(err.message);
    }
  }

  // Add Paper to Slot
  async function handleAssignSlot(e) {
    e.preventDefault();
    if (!assigningSession || !slotFormData.submissionId) return;
    setError('');
    setSuccess('');
    try {
      const csrf = await getCsrf();
      const res = await fetch(`${API}/api/admin/conferences/${selectedConferenceId}/sessions/${assigningSession.id}/slots`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({
          submissionId: slotFormData.submissionId,
          presenterUserId: slotFormData.presenterUserId || null,
          durationMinutes: Number(slotFormData.durationMinutes) || 15,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed to assign paper to session.');

      setSuccess('Paper assigned to presentation slot.');
      setAssigningSession(null);
      setSlotFormData({ submissionId: '', presenterUserId: '', durationMinutes: 15 });
      refreshData();
    } catch (err) {
      setError(err.message);
    }
  }

  // Remove Slot
  async function removeSlot(sessionId, slotId) {
    if (!window.confirm('Remove this paper from the session?')) return;
    try {
      const csrf = await getCsrf();
      const res = await fetch(`${API}/api/admin/conferences/${selectedConferenceId}/sessions/${sessionId}/slots/${slotId}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'X-CSRF-Token': csrf },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error?.message || 'Failed to remove slot.');
      }
      setSuccess('Paper removed from session.');
      refreshData();
    } catch (err) {
      setError(err.message);
    }
  }

  function openCreateModal() {
    setEditingSession(null);
    setSessionFormData({
      title: '',
      sessionCode: '',
      description: '',
      trackId: '',
      venue: '',
      room: '',
      format: 'in_person',
      sessionType: 'paper_session',
      startsAt: '',
      endsAt: '',
      sessionChairId: '',
      isPublished: false,
    });
    setShowSessionModal(true);
  }

  function openEditModal(session) {
    setEditingSession(session);
    setSessionFormData({
      title: session.title,
      sessionCode: session.session_code || '',
      description: session.description || '',
      trackId: session.track_id || '',
      venue: session.venue || '',
      room: session.room,
      format: session.format || 'in_person',
      sessionType: session.session_type || 'paper_session',
      startsAt: session.starts_at ? new Date(session.starts_at).toISOString().slice(0, 16) : '',
      endsAt: session.ends_at ? new Date(session.ends_at).toISOString().slice(0, 16) : '',
      sessionChairId: session.chair_id || '',
      isPublished: session.is_published,
    });
    setShowSessionModal(true);
  }

  return (
    <div className="schedule-container">
      <div className="schedule-header">
        <p className="eyebrow">ADMINISTRATION</p>
        <h1>Conference Scheduling & Attendance Management</h1>
        <p className="page-lead">
          Design conference sessions, detect room/chair conflicts, assign accepted papers, and monitor attendance reports.
        </p>

        <div style={{ marginTop: '1.25rem', display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <label style={{ fontWeight: 600 }}>Conference:</label>
          <select
            value={selectedConferenceId}
            onChange={(e) => setSelectedConferenceId(e.target.value)}
            style={{ padding: '0.4rem 0.8rem', borderRadius: '4px', border: '1px solid #cbd5e1' }}
          >
            {conferences.map((c) => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="state-box state-error" role="alert"><p>{error}</p></div>}
      {success && <div className="form-message success" role="status"><p>{success}</p></div>}

      {/* Sub Navigation */}
      <div className="admin-subnav">
        <button
          type="button"
          className={`admin-subnav-btn ${activeTab === 'sessions' ? 'active' : ''}`}
          onClick={() => setActiveTab('sessions')}
        >
          Sessions & Schedule Builder ({sessions.length})
        </button>
        <button
          type="button"
          className={`admin-subnav-btn ${activeTab === 'slots' ? 'active' : ''}`}
          onClick={() => setActiveTab('slots')}
        >
          Eligible Accepted Papers ({eligiblePapers.length})
        </button>
        <button
          type="button"
          className={`admin-subnav-btn ${activeTab === 'report' ? 'active' : ''}`}
          onClick={() => setActiveTab('report')}
        >
          Attendance & Certificate Eligibility
        </button>
      </div>

      {/* SESSIONS BUILDER TAB */}
      {activeTab === 'sessions' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
            <h2>Sessions Program ({sessions.length})</h2>
            <button type="button" className="button button-green" onClick={openCreateModal}>
              + Create New Session
            </button>
          </div>

          {loading ? (
            <div className="state-box"><span className="spinner"/> Loading sessions...</div>
          ) : sessions.length > 0 ? (
            <div className="sessions-grid">
              {sessions.map((s) => (
                <div key={s.id} className="session-card">
                  <div className="session-card-header">
                    <div className="session-title-group">
                      {s.session_code && <span className="meta-pill">{s.session_code}</span>}
                      <h3>{s.title}</h3>
                      <div className="session-meta-pills">
                        <span className="meta-pill green">Room: {s.room}</span>
                        {s.track_name && <span className="meta-pill">{s.track_name}</span>}
                        <span className="meta-pill capitalize">{s.format?.replace('_', ' ')}</span>
                        <span className="meta-pill capitalize">{s.session_type?.replace('_', ' ')}</span>
                        <span className={`meta-pill ${s.is_published ? 'green' : ''}`}>
                          {s.is_published ? 'Published' : 'Draft (Unpublished)'}
                        </span>
                      </div>
                    </div>
                    <div className="session-time-venue">
                      <strong>
                        {new Date(s.starts_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} –{' '}
                        {new Date(s.ends_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </strong>
                      <span>{new Date(s.starts_at).toLocaleDateString([], { dateStyle: 'medium' })}</span>
                    </div>
                  </div>

                  <div className="session-chair-info">
                    <strong>Session Chair:</strong> {s.chair_name || 'Not assigned'}
                    {s.chair_institution ? ` (${s.chair_institution})` : ''}
                  </div>

                  {/* Presentation Slots */}
                  <div className="slots-section">
                    <div className="slots-heading" style={{ justifyContent: 'space-between' }}>
                      <span>Presentation Slots ({s.presentation_slots?.length || 0})</span>
                      <button
                        type="button"
                        className="button button-outline"
                        style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
                        onClick={() => {
                          setAssigningSession(s);
                          setSlotFormData({ submissionId: '', presenterUserId: '', durationMinutes: 15 });
                        }}
                      >
                        + Assign Paper
                      </button>
                    </div>

                    {s.presentation_slots?.length > 0 ? (
                      s.presentation_slots.map((slot) => (
                        <div key={slot.id} className="slot-item">
                          <div className="slot-info">
                            <div>
                              <span className="meta-pill" style={{ marginRight: '0.5rem' }}>{slot.paperCode}</span>
                              <strong>{slot.title}</strong>
                            </div>
                            <div className="slot-authors">
                              Presenter: {slot.presenter?.fullName || 'TBA'} · Duration: {slot.durationMinutes}m ·
                              Status: <span className={`status-badge status-${slot.presentationStatus}`}>{slot.presentationStatus}</span>
                            </div>
                          </div>
                          <div>
                            <button
                              type="button"
                              className="button button-outline"
                              style={{ color: '#dc2626', borderColor: '#fca5a5', padding: '0.2rem 0.4rem', fontSize: '0.75rem' }}
                              onClick={() => removeSlot(s.id, slot.id)}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="muted" style={{ fontSize: '0.85rem' }}>No papers assigned yet.</p>
                    )}
                  </div>

                  {/* Actions */}
                  <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="button button-outline"
                      style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem' }}
                      onClick={() => togglePublish(s)}
                    >
                      {s.is_published ? 'Unpublish' : 'Publish Schedule'}
                    </button>
                    <button
                      type="button"
                      className="button button-outline"
                      style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem' }}
                      onClick={() => openEditModal(s)}
                    >
                      Edit Session
                    </button>
                    <button
                      type="button"
                      className="button button-outline"
                      style={{ color: '#dc2626', borderColor: '#fca5a5', fontSize: '0.8rem', padding: '0.3rem 0.6rem' }}
                      onClick={() => deleteSession(s.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="state-box empty-state">
              <h2>No sessions created yet</h2>
              <p>Click "+ Create New Session" above to configure your conference rooms and timetable.</p>
            </div>
          )}
        </div>
      )}

      {/* ELIGIBLE PAPERS TAB */}
      {activeTab === 'slots' && (
        <div>
          <h2>Eligible Accepted Papers</h2>
          <p className="muted" style={{ marginBottom: '1rem' }}>
            Only accepted, camera-ready, or finalized papers can be scheduled into presentation slots.
          </p>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Paper Code</th>
                  <th>Title</th>
                  <th>Track</th>
                  <th>Status</th>
                  <th>Submitter</th>
                  <th>Assigned Session</th>
                </tr>
              </thead>
              <tbody>
                {eligiblePapers.map((p) => {
                  const assignedSession = sessions.find((s) => s.id === p.assigned_session_id);
                  return (
                    <tr key={p.id}>
                      <td><span className="meta-pill green">{p.paper_code}</span></td>
                      <td><strong>{p.title}</strong></td>
                      <td>{p.track_name || 'General'}</td>
                      <td><span className="meta-pill capitalize">{p.status}</span></td>
                      <td>{p.submitter_name} ({p.submitter_email})</td>
                      <td>
                        {assignedSession ? (
                          <span className="meta-pill green">
                            {assignedSession.title} ({assignedSession.room})
                          </span>
                        ) : (
                          <span className="muted">Unassigned</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ATTENDANCE REPORT TAB */}
      {activeTab === 'report' && (
        <div>
          <h2>Attendance & Certificate Eligibility Report</h2>
          <p className="muted" style={{ marginBottom: '1.5rem' }}>
            Conference total sessions: <strong>{attendanceReport?.totalConferenceSessions || 0}</strong>.
            Attendees must attend at least 1 session or complete their paper presentation to qualify for a certificate.
          </p>

          {loading ? (
            <div className="state-box"><span className="spinner"/> Generating report...</div>
          ) : attendanceReport?.attendees?.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Attendee</th>
                    <th>Email</th>
                    <th>Category</th>
                    <th>Attended Sessions</th>
                    <th>Completed Presentations</th>
                    <th>Attendance %</th>
                    <th>Certificate Status</th>
                  </tr>
                </thead>
                <tbody>
                  {attendanceReport.attendees.map((row) => (
                    <tr key={row.user_id}>
                      <td><strong>{row.full_name}</strong><br/><small className="muted">{row.institution || '—'}</small></td>
                      <td>{row.email}</td>
                      <td><span className="meta-pill capitalize">{row.registration_category?.replace('_', ' ')}</span></td>
                      <td><strong>{row.attended_sessions_count}</strong></td>
                      <td>{row.completed_presentations_count}</td>
                      <td>{row.attendancePercent}%</td>
                      <td>
                        {row.issued_certificate_number ? (
                          <span className="meta-pill green">Issued ({row.issued_certificate_number})</span>
                        ) : row.isCertificateEligible ? (
                          <span className="meta-pill green">✓ Eligible</span>
                        ) : (
                          <span className="meta-pill">Not yet eligible</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No attendance or registration records found.</p>
          )}
        </div>
      )}

      {/* CREATE / EDIT SESSION MODAL */}
      {showSessionModal && (
        <div className="modal-backdrop" onClick={() => setShowSessionModal(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editingSession ? 'Edit Session' : 'Create New Session'}</h2>
              <button type="button" className="modal-close-btn" onClick={() => setShowSessionModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <form onSubmit={handleSessionSubmit}>
                <label style={{ display: 'block', marginBottom: '0.75rem', fontWeight: 600 }}>
                  Session Title:
                  <input
                    type="text"
                    required
                    value={sessionFormData.title}
                    onChange={(e) => setSessionFormData({ ...sessionFormData, title: e.target.value })}
                    style={{ width: '100%', padding: '0.5rem', marginTop: '0.2rem', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                    placeholder="e.g. Session 1A: Machine Learning & NLP"
                  />
                </label>

                <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.75rem' }}>
                  <label style={{ flex: 1, fontWeight: 600 }}>
                    Session Code:
                    <input
                      type="text"
                      value={sessionFormData.sessionCode}
                      onChange={(e) => setSessionFormData({ ...sessionFormData, sessionCode: e.target.value })}
                      style={{ width: '100%', padding: '0.5rem', marginTop: '0.2rem', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                      placeholder="e.g. S-101"
                    />
                  </label>
                  <label style={{ flex: 1, fontWeight: 600 }}>
                    Track:
                    <select
                      value={sessionFormData.trackId}
                      onChange={(e) => setSessionFormData({ ...sessionFormData, trackId: e.target.value })}
                      style={{ width: '100%', padding: '0.5rem', marginTop: '0.2rem', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                    >
                      <option value="">No specific track</option>
                      {tracks.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  </label>
                </div>

                <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.75rem' }}>
                  <label style={{ flex: 1, fontWeight: 600 }}>
                    Room / Hall:
                    <input
                      type="text"
                      required
                      value={sessionFormData.room}
                      onChange={(e) => setSessionFormData({ ...sessionFormData, room: e.target.value })}
                      style={{ width: '100%', padding: '0.5rem', marginTop: '0.2rem', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                      placeholder="e.g. Auditorium 2"
                    />
                  </label>
                  <label style={{ flex: 1, fontWeight: 600 }}>
                    Venue / Building:
                    <input
                      type="text"
                      value={sessionFormData.venue}
                      onChange={(e) => setSessionFormData({ ...sessionFormData, venue: e.target.value })}
                      style={{ width: '100%', padding: '0.5rem', marginTop: '0.2rem', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                      placeholder="e.g. Academic Complex"
                    />
                  </label>
                </div>

                <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.75rem' }}>
                  <label style={{ flex: 1, fontWeight: 600 }}>
                    Format:
                    <select
                      value={sessionFormData.format}
                      onChange={(e) => setSessionFormData({ ...sessionFormData, format: e.target.value })}
                      style={{ width: '100%', padding: '0.5rem', marginTop: '0.2rem', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                    >
                      <option value="in_person">In Person</option>
                      <option value="virtual">Virtual</option>
                      <option value="hybrid">Hybrid</option>
                    </select>
                  </label>
                  <label style={{ flex: 1, fontWeight: 600 }}>
                    Session Type:
                    <select
                      value={sessionFormData.sessionType}
                      onChange={(e) => setSessionFormData({ ...sessionFormData, sessionType: e.target.value })}
                      style={{ width: '100%', padding: '0.5rem', marginTop: '0.2rem', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                    >
                      <option value="paper_session">Paper Session</option>
                      <option value="keynote">Keynote</option>
                      <option value="poster_session">Poster Session</option>
                      <option value="workshop">Workshop</option>
                      <option value="panel">Panel</option>
                      <option value="break">Break</option>
                    </select>
                  </label>
                </div>

                <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.75rem' }}>
                  <label style={{ flex: 1, fontWeight: 600 }}>
                    Starts At:
                    <input
                      type="datetime-local"
                      required
                      value={sessionFormData.startsAt}
                      onChange={(e) => setSessionFormData({ ...sessionFormData, startsAt: e.target.value })}
                      style={{ width: '100%', padding: '0.5rem', marginTop: '0.2rem', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                    />
                  </label>
                  <label style={{ flex: 1, fontWeight: 600 }}>
                    Ends At:
                    <input
                      type="datetime-local"
                      required
                      value={sessionFormData.endsAt}
                      onChange={(e) => setSessionFormData({ ...sessionFormData, endsAt: e.target.value })}
                      style={{ width: '100%', padding: '0.5rem', marginTop: '0.2rem', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                    />
                  </label>
                </div>

                <label style={{ display: 'block', marginBottom: '0.75rem', fontWeight: 600 }}>
                  Assign Session Chair:
                  <select
                    value={sessionFormData.sessionChairId}
                    onChange={(e) => setSessionFormData({ ...sessionFormData, sessionChairId: e.target.value })}
                    style={{ width: '100%', padding: '0.5rem', marginTop: '0.2rem', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                  >
                    <option value="">Select Session Chair (optional)</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>{u.full_name} ({u.email})</option>
                    ))}
                  </select>
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '1rem 0', fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={sessionFormData.isPublished}
                    onChange={(e) => setSessionFormData({ ...sessionFormData, isPublished: e.target.checked })}
                  />
                  Publish this session on public schedule immediately
                </label>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1.5rem' }}>
                  <button type="button" className="button button-outline" onClick={() => setShowSessionModal(false)}>
                    Cancel
                  </button>
                  <button type="submit" className="button button-green">
                    {editingSession ? 'Save Changes' : 'Create Session'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* ASSIGN PAPER MODAL */}
      {assigningSession && (
        <div className="modal-backdrop" onClick={() => setAssigningSession(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Assign Paper to {assigningSession.title}</h2>
              <button type="button" className="modal-close-btn" onClick={() => setAssigningSession(null)}>&times;</button>
            </div>
            <div className="modal-body">
              <form onSubmit={handleAssignSlot}>
                <label style={{ display: 'block', marginBottom: '0.75rem', fontWeight: 600 }}>
                  Choose Accepted Paper:
                  <select
                    required
                    value={slotFormData.submissionId}
                    onChange={(e) => setSlotFormData({ ...slotFormData, submissionId: e.target.value })}
                    style={{ width: '100%', padding: '0.5rem', marginTop: '0.2rem', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                  >
                    <option value="">Select paper...</option>
                    {eligiblePapers
                      .filter((p) => !p.assigned_session_id)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          [{p.paper_code}] {p.title} ({p.submitter_name})
                        </option>
                      ))}
                  </select>
                </label>

                <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.75rem' }}>
                  <label style={{ flex: 1, fontWeight: 600 }}>
                    Duration (Minutes):
                    <input
                      type="number"
                      min="5"
                      max="180"
                      required
                      value={slotFormData.durationMinutes}
                      onChange={(e) => setSlotFormData({ ...slotFormData, durationMinutes: e.target.value })}
                      style={{ width: '100%', padding: '0.5rem', marginTop: '0.2rem', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                    />
                  </label>
                  <label style={{ flex: 2, fontWeight: 600 }}>
                    Presenter User:
                    <select
                      value={slotFormData.presenterUserId}
                      onChange={(e) => setSlotFormData({ ...slotFormData, presenterUserId: e.target.value })}
                      style={{ width: '100%', padding: '0.5rem', marginTop: '0.2rem', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                    >
                      <option value="">Default to Submitter</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>{u.full_name} ({u.email})</option>
                      ))}
                    </select>
                  </label>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1.5rem' }}>
                  <button type="button" className="button button-outline" onClick={() => setAssigningSession(null)}>
                    Cancel
                  </button>
                  <button type="submit" className="button button-green">
                    Add Presentation Slot
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState, useMemo } from 'react';
import './scheduling.css';

const API = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

function formatTime(isoString, tz = 'Asia/Dhaka') {
  if (!isoString) return '';
  return new Intl.DateTimeFormat('en', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz,
  }).format(new Date(isoString));
}

function formatDate(isoString, tz = 'Asia/Dhaka') {
  if (!isoString) return '';
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeZone: tz,
  }).format(new Date(isoString));
}

export default function SchedulePage({ user }) {
  const params = new URLSearchParams(window.location.search);
  const [conferenceId, setConferenceId] = useState(params.get('conferenceId') || '');
  const [conferences, setConferences] = useState([]);
  const [loadingConferences, setLoadingConferences] = useState(true);

  // Filters
  const [activeTab, setActiveTab] = useState('all'); // 'all' or 'my'
  const [selectedDay, setSelectedDay] = useState('');
  const [selectedRoom, setSelectedRoom] = useState('');
  const [selectedTrack, setSelectedTrack] = useState('');
  const [selectedFormat, setSelectedFormat] = useState('');

  // Data
  const [scheduleData, setScheduleData] = useState(null);
  const [mySchedule, setMySchedule] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Check-in modal
  const [checkInSession, setCheckInSession] = useState(null);
  const [qrTokenInput, setQrTokenInput] = useState('');
  const [checkInState, setCheckInState] = useState({ loading: false, error: '', success: '' });

  // Load available published conferences
  useEffect(() => {
    fetch(`${API}/api/conferences?limit=100`, { credentials: 'include' })
      .then((res) => res.json())
      .then((res) => {
        const list = res.data || [];
        setConferences(list);
        if (!conferenceId && list.length > 0) {
          setConferenceId(list[0].id);
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoadingConferences(false));
  }, []);

  // Fetch Public Schedule
  useEffect(() => {
    if (!conferenceId || activeTab === 'my') return;
    setLoading(true);
    setError('');

    const query = new URLSearchParams();
    if (selectedDay) query.set('date', selectedDay);
    if (selectedRoom) query.set('room', selectedRoom);
    if (selectedTrack) query.set('trackId', selectedTrack);
    if (selectedFormat) query.set('format', selectedFormat);

    fetch(`${API}/api/conferences/${conferenceId}/schedule?${query.toString()}`, { credentials: 'include' })
      .then((res) => res.json())
      .then((res) => {
        if (res.error) throw new Error(res.error.message);
        setScheduleData(res.data);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [conferenceId, selectedDay, selectedRoom, selectedTrack, selectedFormat, activeTab]);

  // Fetch My Schedule if logged in & active tab is 'my'
  useEffect(() => {
    if (activeTab !== 'my' || !user) return;
    setLoading(true);
    setError('');

    fetch(`${API}/api/schedule/my`, { credentials: 'include' })
      .then((res) => res.json())
      .then((res) => {
        if (res.error) throw new Error(res.error.message);
        setMySchedule(res.data);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [activeTab, user]);

  const activeConference = useMemo(() => {
    return conferences.find((c) => c.id === conferenceId) || null;
  }, [conferences, conferenceId]);

  // Handle Attendance Check-in
  async function handleCheckInSubmit(e) {
    e.preventDefault();
    if (!checkInSession) return;
    setCheckInState({ loading: true, error: '', success: '' });

    try {
      const csrfRes = await fetch(`${API}/api/auth/csrf`, { credentials: 'include' });
      const csrfData = await csrfRes.json();
      if (!csrfRes.ok) throw new Error(csrfData?.error?.message || 'Failed to initialize CSRF.');

      const res = await fetch(`${API}/api/sessions/${checkInSession.id}/check-in`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfData.data.csrfToken,
        },
        body: JSON.stringify({ token: qrTokenInput.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Check-in failed.');

      setCheckInState({
        loading: false,
        error: '',
        success: data.data.message || 'You have successfully checked into this session!',
      });
    } catch (err) {
      setCheckInState({ loading: false, error: err.message, success: '' });
    }
  }

  return (
    <div className="schedule-container">
      <div className="schedule-header">
        <p className="eyebrow">PROGRAMME & SCHEDULE</p>
        <h1>Conference Schedule</h1>
        <p className="page-lead">
          Explore day-by-day research tracks, keynote sessions, paper presentations, and attendance check-in.
        </p>

        <div style={{ marginTop: '1rem', display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <label htmlFor="conf-select" style={{ fontWeight: 600, marginRight: '0.5rem' }}>Select Conference:</label>
            <select
              id="conf-select"
              value={conferenceId}
              onChange={(e) => {
                setConferenceId(e.target.value);
                setSelectedDay('');
              }}
              style={{ padding: '0.4rem 0.8rem', borderRadius: '4px', border: '1px solid #cbd5e1' }}
            >
              {conferences.map((c) => (
                <option key={c.id} value={c.id}>{c.title}</option>
              ))}
            </select>
          </div>

          {user && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
              <button
                type="button"
                className={`button ${activeTab === 'all' ? 'button-green' : 'button-outline'}`}
                onClick={() => setActiveTab('all')}
              >
                Full Conference Schedule
              </button>
              <button
                type="button"
                className={`button ${activeTab === 'my' ? 'button-green' : 'button-outline'}`}
                onClick={() => setActiveTab('my')}
              >
                My Schedule & Check-ins
              </button>
            </div>
          )}
        </div>
      </div>

      {error && <div className="state-box state-error" role="alert"><p>{error}</p></div>}

      {/* MY SCHEDULE TAB */}
      {activeTab === 'my' && user && (
        <div>
          <h2>My Personalized Schedule</h2>
          <p className="muted" style={{ marginBottom: '1.5rem' }}>
            Sessions you are chairing, presenting in, or have checked into.
          </p>

          {loading ? (
            <div className="state-box"><span className="spinner"/> Loading your schedule...</div>
          ) : (
            <div>
              {/* My Presentations */}
              <div style={{ marginBottom: '2rem' }}>
                <h3 style={{ borderBottom: '2px solid #e2e8f0', paddingBottom: '0.5rem' }}>
                  My Paper Presentations
                </h3>
                {mySchedule?.myPresentations?.length > 0 ? (
                  <div className="sessions-grid">
                    {mySchedule.myPresentations.map((p) => (
                      <div key={p.slot_id} className="session-card">
                        <div className="session-card-header">
                          <div className="session-title-group">
                            <span className="meta-pill green">{p.paper_code}</span>
                            <h3>{p.paper_title}</h3>
                            <div className="session-meta-pills">
                              <span className="meta-pill">Session: {p.session_title}</span>
                              <span className="meta-pill">Room: {p.room || 'TBA'}</span>
                              <span className={`status-badge status-${p.presentation_status}`}>
                                {p.presentation_status.replace('_', ' ')}
                              </span>
                            </div>
                          </div>
                          <div className="session-time-venue">
                            <strong>{formatTime(p.slot_starts_at || p.session_starts_at)}</strong>
                            <span>{formatDate(p.slot_starts_at || p.session_starts_at)}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted">You have no paper presentations scheduled.</p>
                )}
              </div>

              {/* Chaired Sessions */}
              <div style={{ marginBottom: '2rem' }}>
                <h3 style={{ borderBottom: '2px solid #e2e8f0', paddingBottom: '0.5rem' }}>
                  Sessions I Am Chairing
                </h3>
                {mySchedule?.chairedSessions?.length > 0 ? (
                  <div className="sessions-grid">
                    {mySchedule.chairedSessions.map((s) => (
                      <div key={s.id} className="session-card" style={{ borderLeftColor: '#7c3aed' }}>
                        <div className="session-card-header">
                          <div className="session-title-group">
                            <h3>{s.title}</h3>
                            <div className="session-meta-pills">
                              <span className="meta-pill purple">Session Chair</span>
                              <span className="meta-pill">Room: {s.room || 'TBA'}</span>
                              <span className="meta-pill">{s.slot_count || 0} presentations</span>
                            </div>
                          </div>
                          <div className="session-time-venue">
                            <strong>{formatTime(s.starts_at)} – {formatTime(s.ends_at)}</strong>
                            <span>{formatDate(s.starts_at)}</span>
                          </div>
                        </div>
                        <div style={{ marginTop: '0.75rem' }}>
                          <a href={`/chair?sessionId=${s.id}`} className="button button-outline" style={{ fontSize: '0.8rem' }}>
                            Open Chair Dashboard →
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted">You are not designated as a session chair.</p>
                )}
              </div>

              {/* My Attendance */}
              <div>
                <h3 style={{ borderBottom: '2px solid #e2e8f0', paddingBottom: '0.5rem' }}>
                  Recorded Session Attendance
                </h3>
                {mySchedule?.myAttendance?.length > 0 ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Session Title</th>
                          <th>Room</th>
                          <th>Role</th>
                          <th>Check-in Method</th>
                          <th>Checked In At</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mySchedule.myAttendance.map((a) => (
                          <tr key={a.attendance_id}>
                            <td><strong>{a.session_title}</strong></td>
                            <td>{a.room || '—'}</td>
                            <td><span className="meta-pill capitalize">{a.attendance_role}</span></td>
                            <td>{a.check_in_method === 'qr_code' ? '📱 QR Code' : a.check_in_method}</td>
                            <td>{new Date(a.checked_in_at).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="muted">No session check-ins recorded yet.</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* FULL PUBLIC SCHEDULE TAB */}
      {activeTab === 'all' && (
        <div>
          {/* Day selection tabs */}
          {scheduleData?.availableDays?.length > 0 && (
            <div className="day-tabs">
              <button
                type="button"
                className={`day-tab-btn ${selectedDay === '' ? 'active' : ''}`}
                onClick={() => setSelectedDay('')}
              >
                All Days
              </button>
              {scheduleData.availableDays.map((day) => (
                <button
                  type="button"
                  key={day}
                  className={`day-tab-btn ${selectedDay === day ? 'active' : ''}`}
                  onClick={() => setSelectedDay(day)}
                >
                  {formatDate(day)}
                </button>
              ))}
            </div>
          )}

          {/* Filters Bar */}
          <div className="schedule-filters-card">
            <div className="filters-row">
              <label>
                Room
                <select value={selectedRoom} onChange={(e) => setSelectedRoom(e.target.value)}>
                  <option value="">All Rooms</option>
                  {(scheduleData?.availableRooms || []).map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </label>

              <label>
                Track
                <select value={selectedTrack} onChange={(e) => setSelectedTrack(e.target.value)}>
                  <option value="">All Tracks</option>
                  {(scheduleData?.availableTracks || []).map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </label>

              <label>
                Format
                <select value={selectedFormat} onChange={(e) => setSelectedFormat(e.target.value)}>
                  <option value="">All Formats</option>
                  <option value="in_person">In Person</option>
                  <option value="virtual">Virtual</option>
                  <option value="hybrid">Hybrid</option>
                </select>
              </label>

              {(selectedDay || selectedRoom || selectedTrack || selectedFormat) && (
                <button
                  type="button"
                  className="button button-outline"
                  style={{ alignSelf: 'flex-end', height: '38px', fontSize: '0.85rem' }}
                  onClick={() => {
                    setSelectedDay('');
                    setSelectedRoom('');
                    setSelectedTrack('');
                    setSelectedFormat('');
                  }}
                >
                  Clear Filters
                </button>
              )}
            </div>
          </div>

          {/* Schedule list */}
          {loading ? (
            <div className="state-box"><span className="spinner"/> Loading sessions...</div>
          ) : scheduleData?.sessions?.length > 0 ? (
            <div className="sessions-grid">
              {scheduleData.sessions.map((session) => (
                <article key={session.id} className="session-card">
                  <div className="session-card-header">
                    <div className="session-title-group">
                      {session.session_code && <span className="meta-pill">{session.session_code}</span>}
                      <h3>{session.title}</h3>
                      <div className="session-meta-pills">
                        <span className="meta-pill green">{session.room || 'Room TBA'}</span>
                        {session.track_name && <span className="meta-pill">{session.track_name}</span>}
                        <span className="meta-pill capitalize">{session.format?.replace('_', ' ')}</span>
                        <span className="meta-pill capitalize">{session.session_type?.replace('_', ' ')}</span>
                      </div>
                    </div>

                    <div className="session-time-venue">
                      <strong>
                        {formatTime(session.starts_at, session.timezone)} – {formatTime(session.ends_at, session.timezone)}
                      </strong>
                      <span>{formatDate(session.starts_at, session.timezone)}</span>
                    </div>
                  </div>

                  {session.description && (
                    <p style={{ margin: '0.5rem 0', fontSize: '0.9rem', color: '#475569' }}>
                      {session.description}
                    </p>
                  )}

                  {session.chair_name && (
                    <div className="session-chair-info">
                      <strong>Session Chair:</strong> {session.chair_name}
                      {session.chair_institution ? ` (${session.chair_institution})` : ''}
                    </div>
                  )}

                  {/* Presentation Slots */}
                  {session.presentation_slots?.length > 0 && (
                    <div className="slots-section">
                      <div className="slots-heading">
                        <span>Presentation Papers ({session.presentation_slots.length})</span>
                      </div>
                      <div>
                        {session.presentation_slots.map((slot) => (
                          <div key={slot.id} className="slot-item">
                            <div className="slot-info">
                              <div>
                                <span className="meta-pill" style={{ marginRight: '0.5rem' }}>{slot.paperCode}</span>
                                <strong>{slot.title}</strong>
                              </div>
                              <div className="slot-authors">
                                Authors: {slot.authors?.length > 0 ? slot.authors.map((a) => a.fullName).join(', ') : 'Authors listed in proceedings'}
                                {slot.presenter?.fullName && ` · Presenter: ${slot.presenter.fullName}`}
                                {slot.durationMinutes && ` · ${slot.durationMinutes} mins`}
                              </div>
                            </div>
                            <div>
                              <span className={`status-badge status-${slot.presentationStatus}`}>
                                {slot.presentationStatus?.replace('_', ' ')}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Check-in CTA */}
                  <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="button button-outline"
                      style={{ fontSize: '0.85rem', padding: '0.4rem 0.8rem' }}
                      onClick={() => {
                        setCheckInSession(session);
                        setCheckInState({ loading: false, error: '', success: '' });
                        setQrTokenInput('');
                      }}
                    >
                      Check In to Session
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="state-box empty-state">
              <h2>No sessions published yet</h2>
              <p>There are no scheduled sessions matching your filter criteria for this conference.</p>
            </div>
          )}
        </div>
      )}

      {/* Check In Modal */}
      {checkInSession && (
        <div className="modal-backdrop" onClick={() => setCheckInSession(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Session Attendance Check-In</h2>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setCheckInSession(null)}
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <p><strong>Session:</strong> {checkInSession.title}</p>
              <p><strong>Room:</strong> {checkInSession.room}</p>
              <p><strong>Time:</strong> {formatTime(checkInSession.starts_at)} – {formatTime(checkInSession.ends_at)}</p>

              {checkInState.error && <p className="form-message error">{checkInState.error}</p>}
              {checkInState.success ? (
                <div className="form-message success">
                  <p>{checkInState.success}</p>
                  <button
                    type="button"
                    className="button button-green"
                    style={{ marginTop: '1rem' }}
                    onClick={() => {
                      setCheckInSession(null);
                      if (activeTab === 'my') window.location.reload();
                    }}
                  >
                    Done
                  </button>
                </div>
              ) : (
                <form onSubmit={handleCheckInSubmit}>
                  {!user ? (
                    <div>
                      <p className="form-message error">
                        You must be signed in to record attendance.
                      </p>
                      <a href={`/login?next=/schedule?conferenceId=${conferenceId}`} className="button button-green">
                        Sign In Now →
                      </a>
                    </div>
                  ) : (
                    <>
                      <label style={{ display: 'block', margin: '1rem 0 0.5rem 0', fontWeight: 600 }}>
                        Session Token or QR Code Token (Optional if checking in inside venue):
                        <input
                          type="text"
                          placeholder="Paste token or leave empty for standard check-in"
                          value={qrTokenInput}
                          onChange={(e) => setQrTokenInput(e.target.value)}
                          style={{ width: '100%', padding: '0.6rem', marginTop: '0.25rem', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                        />
                      </label>
                      <small className="muted">
                        If the session chair has projected a rotating QR code or provided a passcode, enter it above.
                      </small>
                      <div style={{ marginTop: '1.5rem', display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          className="button button-outline"
                          onClick={() => setCheckInSession(null)}
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          className="button button-green"
                          disabled={checkInState.loading}
                        >
                          {checkInState.loading ? 'Recording...' : 'Confirm Check-In'}
                        </button>
                      </div>
                    </>
                  )}
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

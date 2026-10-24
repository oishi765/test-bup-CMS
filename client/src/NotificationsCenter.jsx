import { useState, useEffect } from 'react';

const API = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

async function fetchCsrf() {
  const res = await fetch(`${API}/api/auth/csrf`, { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  return data.data?.csrfToken || '';
}

export function NotificationBell({ user }) {
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [filter, setFilter] = useState('all');
  const [showPrefs, setShowPrefs] = useState(false);
  const [prefs, setPrefs] = useState({
    email_notifications: true,
    submission_updates: true,
    review_updates: true,
    schedule_updates: true,
    announcements: true,
  });
  const [loadingPrefs, setLoadingPrefs] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [prefMessage, setPrefMessage] = useState('');

  const loadNotifications = async () => {
    if (!user) return;
    try {
      const url = `${API}/api/notifications?limit=30${filter !== 'all' ? `&category=${filter}` : ''}`;
      const res = await fetch(url, { credentials: 'include' });
      if (res.ok) {
        const json = await res.json();
        setNotifications(json.data?.notifications || []);
        setUnreadCount(json.data?.unread_count || 0);
      }
    } catch {
      // ignore network errors
    }
  };

  useEffect(() => {
    loadNotifications();
    const interval = setInterval(loadNotifications, 30000); // 30s background poll
    return () => clearInterval(interval);
  }, [user, filter]);

  const markAsRead = async (id) => {
    try {
      const csrf = await fetchCsrf();
      const res = await fetch(`${API}/api/notifications/${id}/read`, {
        method: 'PATCH',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
        },
      });
      if (res.ok) {
        setNotifications((prev) =>
          prev.map((n) => (n.id === id ? { ...n, is_read: true, read_at: new Date().toISOString() } : n))
        );
        setUnreadCount((c) => Math.max(0, c - 1));
      }
    } catch {
      // ignore
    }
  };

  const markAllRead = async () => {
    try {
      const csrf = await fetchCsrf();
      const res = await fetch(`${API}/api/notifications/mark-all-read`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
        },
      });
      if (res.ok) {
        setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true, read_at: new Date().toISOString() })));
        setUnreadCount(0);
      }
    } catch {
      // ignore
    }
  };

  const loadPreferences = async () => {
    setLoadingPrefs(true);
    setPrefMessage('');
    try {
      const res = await fetch(`${API}/api/notifications/preferences`, { credentials: 'include' });
      if (res.ok) {
        const json = await res.json();
        if (json.data?.preferences) {
          setPrefs(json.data.preferences);
        }
      }
    } catch {
      // ignore
    } finally {
      setLoadingPrefs(false);
    }
  };

  const savePreferences = async (e) => {
    e.preventDefault();
    setSavingPrefs(true);
    setPrefMessage('');
    try {
      const csrf = await fetchCsrf();
      const res = await fetch(`${API}/api/notifications/preferences`, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify(prefs),
      });
      if (res.ok) {
        setPrefMessage('Preferences updated successfully.');
        setTimeout(() => setShowPrefs(false), 1200);
      } else {
        const err = await res.json();
        setPrefMessage(err.error?.message || 'Could not save preferences');
      }
    } catch (err) {
      setPrefMessage(err.message);
    } finally {
      setSavingPrefs(false);
    }
  };

  const openPrefsModal = () => {
    setShowPrefs(true);
    loadPreferences();
  };

  if (!user) return null;

  return (
    <>
      <button
        className="notif-bell-btn"
        type="button"
        aria-label="View notifications"
        onClick={() => setIsOpen(!isOpen)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && <span className="notif-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>

      {isOpen && (
        <div className="notif-drawer-backdrop" onClick={() => setIsOpen(false)}>
          <div className="notif-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="notif-drawer-header">
              <h2>Notifications</h2>
              <div className="notif-drawer-actions">
                <button
                  type="button"
                  className="button button-outline"
                  style={{ padding: '4px 8px', fontSize: '11px', minHeight: 'unset' }}
                  onClick={openPrefsModal}
                  title="Notification settings"
                >
                  ⚙ Settings
                </button>
                {unreadCount > 0 && (
                  <button
                    type="button"
                    className="button button-outline"
                    style={{ padding: '4px 8px', fontSize: '11px', minHeight: 'unset' }}
                    onClick={markAllRead}
                  >
                    Mark all read
                  </button>
                )}
                <button
                  type="button"
                  style={{ background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', padding: '4px' }}
                  onClick={() => setIsOpen(false)}
                >
                  ✕
                </button>
              </div>
            </div>

            <div style={{ padding: '8px 16px', borderBottom: '1px solid #f1f5f9', display: 'flex', gap: '6px', overflowX: 'auto' }}>
              {['all', 'submission', 'review', 'registration', 'schedule', 'certificate'].map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setFilter(cat)}
                  style={{
                    background: filter === cat ? '#28734c' : '#f1f5f9',
                    color: filter === cat ? '#fff' : '#64748b',
                    border: 'none',
                    borderRadius: '4px',
                    fontSize: '11px',
                    fontWeight: 600,
                    padding: '3px 8px',
                    cursor: 'pointer',
                    textTransform: 'capitalize',
                  }}
                >
                  {cat}
                </button>
              ))}
            </div>

            <div className="notif-list">
              {notifications.length === 0 ? (
                <div style={{ padding: '40px 20px', textAlign: 'center', color: '#64748b', fontSize: '13px' }}>
                  No notifications to show.
                </div>
              ) : (
                notifications.map((item) => (
                  <div key={item.id} className={`notif-item ${!item.is_read ? 'unread' : ''}`}>
                    <span className={`notif-dot ${item.is_read ? 'read' : ''}`} />
                    <div className="notif-content">
                      <div className="notif-item-top">
                        <span className="notif-category-tag">{item.category || 'general'}</span>
                        <span className="notif-time">
                          {new Date(item.created_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                      <div className="notif-title">{item.title}</div>
                      <div className="notif-body">{item.body || item.message}</div>
                      {!item.is_read && (
                        <button type="button" className="notif-mark-btn" onClick={() => markAsRead(item.id)}>
                          Mark as read
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {showPrefs && (
        <div className="modal-backdrop" onClick={() => setShowPrefs(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Notification Preferences</div>
            <div className="modal-desc">Configure in-app and email delivery options.</div>

            {loadingPrefs ? (
              <p>Loading preferences...</p>
            ) : (
              <form onSubmit={savePreferences}>
                <div className="pref-row">
                  <div className="pref-label">
                    <span className="pref-title">Email Notifications</span>
                    <span className="pref-sub">Receive email alerts when SMTP provider is configured</span>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={prefs.email_notifications}
                      onChange={(e) => setPrefs({ ...prefs, email_notifications: e.target.checked })}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                <div className="pref-row">
                  <div className="pref-label">
                    <span className="pref-title">Paper Submissions</span>
                    <span className="pref-sub">Updates on submission status, reviews, and decisions</span>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={prefs.submission_updates}
                      onChange={(e) => setPrefs({ ...prefs, submission_updates: e.target.checked })}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                <div className="pref-row">
                  <div className="pref-label">
                    <span className="pref-title">Review Assignments</span>
                    <span className="pref-sub">Notifications regarding assigned reviews and deadlines</span>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={prefs.review_updates}
                      onChange={(e) => setPrefs({ ...prefs, review_updates: e.target.checked })}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                <div className="pref-row">
                  <div className="pref-label">
                    <span className="pref-title">Schedule & Sessions</span>
                    <span className="pref-sub">Changes to presentation slots, room assignments, and schedules</span>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={prefs.schedule_updates}
                      onChange={(e) => setPrefs({ ...prefs, schedule_updates: e.target.checked })}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                <div className="pref-row">
                  <div className="pref-label">
                    <span className="pref-title">General Announcements</span>
                    <span className="pref-sub">Official conference broadcasts and certificate releases</span>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={prefs.announcements}
                      onChange={(e) => setPrefs({ ...prefs, announcements: e.target.checked })}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                {prefMessage && (
                  <p
                    style={{
                      marginTop: '1rem',
                      fontSize: '0.85rem',
                      color: prefMessage.includes('success') ? '#16a34a' : '#dc2626',
                    }}
                  >
                    {prefMessage}
                  </p>
                )}

                <div style={{ marginTop: '1.5rem', display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
                  <button
                    type="button"
                    className="button button-outline"
                    onClick={() => setShowPrefs(false)}
                    disabled={savingPrefs}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="button button-green" disabled={savingPrefs}>
                    {savingPrefs ? 'Saving...' : 'Save Preferences'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
export default NotificationBell;

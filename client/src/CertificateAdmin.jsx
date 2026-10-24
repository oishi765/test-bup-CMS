import { useState, useEffect } from 'react';
import './certificates.css';

const API = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

async function fetchCsrf() {
  const res = await fetch(`${API}/api/auth/csrf`, { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  return data.data?.csrfToken || '';
}

export default function CertificateAdmin() {
  const [conferences, setConferences] = useState([]);
  const [selectedConfId, setSelectedConfId] = useState('');
  const [certificates, setCertificates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

  // Revoke Modal state
  const [revokingCert, setRevokingCert] = useState(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revokingLoading, setRevokingLoading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');

  // Manual Issue Modal state
  const [showIssueModal, setShowIssueModal] = useState(false);
  const [usersList, setUsersList] = useState([]);
  const [issueUserId, setIssueUserId] = useState('');
  const [issueType, setIssueType] = useState('attendee');
  const [overrideEligibility, setOverrideEligibility] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [issuingLoading, setIssuingLoading] = useState(false);

  // Template Settings state
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [templateData, setTemplateData] = useState({
    title_template: 'Certificate of {type}',
    body_template: 'This is to certify that {name} has participated in the conference.',
    signature_title: 'Conference Chair',
    signature_name: 'Organizing Committee',
  });
  const [savingTemplate, setSavingTemplate] = useState(false);

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

  const loadCertificates = async () => {
    if (!selectedConfId) return;
    setLoading(true);
    setActionError('');
    try {
      let url = `${API}/api/admin/conferences/${selectedConfId}/certificates?page=${page}&limit=20`;
      if (search) url += `&search=${encodeURIComponent(search)}`;
      if (filterType) url += `&certificate_type=${encodeURIComponent(filterType)}`;
      if (filterStatus) url += `&status=${encodeURIComponent(filterStatus)}`;

      const res = await fetch(url, { credentials: 'include' });
      if (res.ok) {
        const json = await res.json();
        setCertificates(json.data?.certificates || []);
        setTotalCount(json.data?.total || 0);
      } else {
        const err = await res.json().catch(() => ({}));
        setActionError(err.error?.message || 'Failed to load certificates');
      }
    } catch (err) {
      setActionError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadUsers = async () => {
    try {
      const res = await fetch(`${API}/api/auth/admin/users`, { credentials: 'include' });
      if (res.ok) {
        const json = await res.json();
        setUsersList(json.data || []);
      }
    } catch {
      // ignore
    }
  };

  const loadTemplate = async () => {
    if (!selectedConfId) return;
    try {
      const res = await fetch(`${API}/api/admin/conferences/${selectedConfId}/certificates/template`, {
        credentials: 'include',
      });
      if (res.ok) {
        const json = await res.json();
        if (json.data?.template) {
          setTemplateData({
            title_template: json.data.template.title_template || 'Certificate of {type}',
            body_template: json.data.template.body_template || '',
            signature_title: json.data.template.signature_title || 'Conference Chair',
            signature_name: json.data.template.signature_name || 'Organizing Committee',
          });
        }
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadConferences();
    loadUsers();
  }, []);

  useEffect(() => {
    if (selectedConfId) {
      loadCertificates();
      loadTemplate();
    }
  }, [selectedConfId, page, filterType, filterStatus]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    setPage(1);
    loadCertificates();
  };

  const handleDownload = (certId, certNumber) => {
    const downloadUrl = `${API}/api/certificates/${certId}/download`;
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.target = '_blank';
    link.download = `${certNumber || 'certificate'}.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleRevokeSubmit = async (e) => {
    e.preventDefault();
    if (!revokingCert || !revokeReason.trim()) return;
    setRevokingLoading(true);
    setActionError('');
    try {
      const csrf = await fetchCsrf();
      const res = await fetch(`${API}/api/admin/conferences/${selectedConfId}/certificates/${revokingCert.id}/revoke`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify({ reason: revokeReason.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error?.message || 'Revocation failed');

      setActionSuccess(`Certificate ${revokingCert.certificate_number} revoked successfully.`);
      setRevokingCert(null);
      setRevokeReason('');
      loadCertificates();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setRevokingLoading(false);
    }
  };

  const handleIssueSubmit = async (e) => {
    e.preventDefault();
    if (!issueUserId || !issueType) return;
    setIssuingLoading(true);
    setActionError('');
    try {
      const csrf = await fetchCsrf();
      const res = await fetch(`${API}/api/admin/conferences/${selectedConfId}/certificates/issue`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify({
          user_id: issueUserId,
          certificate_type: issueType,
          override_eligibility: overrideEligibility,
          reason: overrideEligibility ? overrideReason : undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error?.message || 'Issuance failed');

      setActionSuccess(`Certificate issued (${json.data?.certificate?.certificate_number})`);
      setShowIssueModal(false);
      setIssueUserId('');
      setOverrideEligibility(false);
      setOverrideReason('');
      loadCertificates();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setIssuingLoading(false);
    }
  };

  const handleSaveTemplate = async (e) => {
    e.preventDefault();
    setSavingTemplate(true);
    setActionError('');
    try {
      const csrf = await fetchCsrf();
      const res = await fetch(`${API}/api/admin/conferences/${selectedConfId}/certificates/template`, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify(templateData),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error?.message || 'Could not update template');
      }
      setActionSuccess('Certificate template updated.');
      setShowTemplateModal(false);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setSavingTemplate(false);
    }
  };

  return (
    <div className="cert-container">
      <div className="page-title" style={{ padding: '20px 0' }}>
        <p className="eyebrow">ADMINISTRATION</p>
        <h1>Certificate Management</h1>
        <p className="page-lead">
          Issue certificates, inspect recipient records, enforce eligibility, configure templates, and manage revocations.
        </p>
      </div>

      {actionSuccess && (
        <div className="form-message success" style={{ marginBottom: '1.25rem' }}>
          {actionSuccess}
        </div>
      )}
      {actionError && (
        <div className="form-message error" style={{ marginBottom: '1.25rem' }}>
          {actionError}
        </div>
      )}

      <div className="admin-toolbar-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <label htmlFor="conf-picker" style={{ fontWeight: 600, fontSize: '0.875rem' }}>
            Conference:
          </label>
          <select
            id="conf-picker"
            value={selectedConfId}
            onChange={(e) => {
              setSelectedConfId(e.target.value);
              setPage(1);
            }}
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
        </div>

        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            type="button"
            className="button button-outline"
            onClick={() => setShowTemplateModal(true)}
          >
            Template Settings ⚙
          </button>
          <button
            type="button"
            className="button button-green"
            onClick={() => setShowIssueModal(true)}
          >
            Issue Certificate ＋
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <form onSubmit={handleSearchSubmit} className="filter-bar" style={{ marginBottom: '1.5rem' }}>
        <label className="search-field" style={{ flex: 2 }}>
          <span className="sr-only">Search recipient or certificate ID</span>
          <span aria-hidden="true">⌕</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by recipient name, email, or certificate number..."
          />
        </label>

        <label className="filter-select">
          Type
          <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
            <option value="">All Types</option>
            <option value="attendee">Attendee</option>
            <option value="presenter">Presenter</option>
            <option value="author">Author</option>
            <option value="reviewer">Reviewer</option>
            <option value="organizer">Organizer</option>
          </select>
        </label>

        <label className="filter-select">
          Status
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="">All Statuses</option>
            <option value="active">Active</option>
            <option value="revoked">Revoked</option>
          </select>
        </label>

        <button className="button button-green" type="submit">
          Filter
        </button>
      </form>

      {/* Certificate Table */}
      {loading ? (
        <div className="state-box" role="status">
          <span className="spinner" /> Loading certificates…
        </div>
      ) : certificates.length === 0 ? (
        <div className="state-box empty-state">
          <span className="empty-icon">✳</span>
          <h2>No certificates found</h2>
          <p>No certificates match the selected filters for this conference.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Certificate ID</th>
                <th>Recipient</th>
                <th>Type</th>
                <th>Issued At</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {certificates.map((cert) => (
                <tr key={cert.id} style={{ opacity: cert.is_revoked ? 0.75 : 1 }}>
                  <td>
                    <code style={{ fontSize: '0.8rem', background: '#f1f5f9', padding: '2px 6px', borderRadius: '4px' }}>
                      {cert.certificate_number}
                    </code>
                  </td>
                  <td>
                    <strong style={{ display: 'block', color: '#1e293b' }}>{cert.recipient_name}</strong>
                    <small style={{ color: '#64748b' }}>{cert.recipient_email}</small>
                  </td>
                  <td>
                    <span className={`cert-badge ${cert.certificate_type}`}>
                      {cert.certificate_type}
                    </span>
                  </td>
                  <td>
                    {new Date(cert.issued_at).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </td>
                  <td>
                    {cert.is_revoked ? (
                      <span className="status-pill-revoked" title={cert.revocation_reason}>
                        Revoked
                      </span>
                    ) : (
                      <span className="status-pill-active">Active</span>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <button
                        type="button"
                        className="button button-outline"
                        style={{ padding: '4px 8px', fontSize: '11px', minHeight: 'unset' }}
                        onClick={() => handleDownload(cert.id, cert.certificate_number)}
                      >
                        PDF
                      </button>
                      <a
                        href={`/certificate-verification?number=${encodeURIComponent(cert.certificate_number)}`}
                        className="quiet-link"
                        style={{ fontSize: '11px' }}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Verify ↗
                      </a>
                      {!cert.is_revoked && (
                        <button
                          type="button"
                          className="button button-outline"
                          style={{
                            padding: '4px 8px',
                            fontSize: '11px',
                            minHeight: 'unset',
                            borderColor: '#fca5a5',
                            color: '#b91c1c',
                          }}
                          onClick={() => setRevokingCert(cert)}
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Revocation Modal */}
      {revokingCert && (
        <div className="modal-backdrop" onClick={() => setRevokingCert(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Revoke Certificate</div>
            <div className="modal-desc">
              Revoking certificate <strong>{revokingCert.certificate_number}</strong> issued to{' '}
              <strong>{revokingCert.recipient_name}</strong>.
            </div>

            <div
              style={{
                background: '#fff1f2',
                borderLeft: '4px solid #e11d48',
                padding: '0.75rem',
                fontSize: '0.85rem',
                color: '#9f1239',
                marginBottom: '1rem',
              }}
            >
              <strong>Caution:</strong> Revocation is permanent. The public verification page will immediately show this certificate as invalid and show the revocation reason.
            </div>

            <form onSubmit={handleRevokeSubmit}>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.5rem' }}>
                Revocation Reason (Required):
              </label>
              <textarea
                value={revokeReason}
                onChange={(e) => setRevokeReason(e.target.value)}
                required
                minLength={5}
                placeholder="State the legitimate reason for revocation (e.g. issued in error, plagiarism, eligibility retracted)..."
                rows={3}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  marginBottom: '1.25rem',
                  fontSize: '0.875rem',
                }}
              />

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
                <button
                  type="button"
                  className="button button-outline"
                  onClick={() => setRevokingCert(null)}
                  disabled={revokingLoading}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button"
                  style={{ background: '#b91c1c', color: '#fff' }}
                  disabled={revokingLoading || !revokeReason.trim()}
                >
                  {revokingLoading ? 'Revoking...' : 'Confirm Revocation'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Manual Issue Modal */}
      {showIssueModal && (
        <div className="modal-backdrop" onClick={() => setShowIssueModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Issue Conference Certificate</div>
            <div className="modal-desc">Select recipient user and certificate type.</div>

            <form onSubmit={handleIssueSubmit}>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.35rem' }}>
                Select User:
              </label>
              <select
                value={issueUserId}
                onChange={(e) => setIssueUserId(e.target.value)}
                required
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  marginBottom: '1rem',
                  fontSize: '0.875rem',
                }}
              >
                <option value="">Choose a user...</option>
                {usersList.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name} ({u.email})
                  </option>
                ))}
              </select>

              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.35rem' }}>
                Certificate Type:
              </label>
              <select
                value={issueType}
                onChange={(e) => setIssueType(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  marginBottom: '1rem',
                  fontSize: '0.875rem',
                }}
              >
                <option value="attendee">Attendee Certificate</option>
                <option value="presenter">Presenter Certificate</option>
                <option value="author">Author Certificate</option>
                <option value="reviewer">Reviewer Certificate</option>
                <option value="organizer">Organizer Certificate</option>
              </select>

              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', marginBottom: '0.75rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={overrideEligibility}
                  onChange={(e) => setOverrideEligibility(e.target.checked)}
                />
                Override standard eligibility rules (Administrative Grant)
              </label>

              {overrideEligibility && (
                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem', color: '#b45309' }}>
                    Reason for Eligibility Override (Audit Record):
                  </label>
                  <textarea
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    required
                    placeholder="Document the administrative justification for overriding normal rules..."
                    rows={2}
                    style={{
                      width: '100%',
                      padding: '0.5rem',
                      border: '1px solid #cbd5e1',
                      borderRadius: '6px',
                      fontSize: '0.85rem',
                    }}
                  />
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1.25rem' }}>
                <button
                  type="button"
                  className="button button-outline"
                  onClick={() => setShowIssueModal(false)}
                  disabled={issuingLoading}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button-green"
                  disabled={issuingLoading || !issueUserId}
                >
                  {issuingLoading ? 'Issuing...' : 'Issue Certificate'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Template Modal */}
      {showTemplateModal && (
        <div className="modal-backdrop" onClick={() => setShowTemplateModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Certificate Template Settings</div>
            <div className="modal-desc">Customize header titles and signatories for this conference.</div>

            <form onSubmit={handleSaveTemplate}>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.25rem' }}>
                Certificate Header Title:
              </label>
              <input
                value={templateData.title_template}
                onChange={(e) => setTemplateData({ ...templateData, title_template: e.target.value })}
                required
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  marginBottom: '1rem',
                  fontSize: '0.875rem',
                }}
              />

              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.25rem' }}>
                Signatory Name:
              </label>
              <input
                value={templateData.signature_name}
                onChange={(e) => setTemplateData({ ...templateData, signature_name: e.target.value })}
                required
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  marginBottom: '1rem',
                  fontSize: '0.875rem',
                }}
              />

              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.25rem' }}>
                Signatory Title:
              </label>
              <input
                value={templateData.signature_title}
                onChange={(e) => setTemplateData({ ...templateData, signature_title: e.target.value })}
                required
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  marginBottom: '1.25rem',
                  fontSize: '0.875rem',
                }}
              />

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
                <button
                  type="button"
                  className="button button-outline"
                  onClick={() => setShowTemplateModal(false)}
                  disabled={savingTemplate}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button-green"
                  disabled={savingTemplate}
                >
                  {savingTemplate ? 'Saving...' : 'Save Template'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect } from 'react';
import './certificates.css';

const API = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

async function fetchCsrf() {
  const res = await fetch(`${API}/api/auth/csrf`, { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  return data.data?.csrfToken || '';
}

export default function CertificatesPage({ user }) {
  const [tab, setTab] = useState('my'); // 'my' or 'claim'
  const [myCertificates, setMyCertificates] = useState([]);
  const [loadingMy, setLoadingMy] = useState(true);
  const [errorMy, setErrorMy] = useState('');

  // Claim tab state
  const [conferences, setConferences] = useState([]);
  const [selectedConferenceId, setSelectedConferenceId] = useState('');
  const [eligibilityData, setEligibilityData] = useState(null);
  const [loadingEligibility, setLoadingEligibility] = useState(false);
  const [claimingType, setClaimingType] = useState(null);
  const [claimMessage, setClaimMessage] = useState({ text: '', type: '' });

  const loadMyCertificates = async () => {
    setLoadingMy(true);
    setErrorMy('');
    try {
      const res = await fetch(`${API}/api/certificates/my`, { credentials: 'include' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error?.message || 'Could not load certificates');
      }
      const json = await res.json();
      setMyCertificates(json.data?.certificates || []);
    } catch (err) {
      setErrorMy(err.message);
    } finally {
      setLoadingMy(false);
    }
  };

  const loadConferences = async () => {
    try {
      const res = await fetch(`${API}/api/conferences?limit=100`, { credentials: 'include' });
      if (res.ok) {
        const json = await res.json();
        const confs = json.data || [];
        setConferences(confs);
        if (confs.length > 0 && !selectedConferenceId) {
          setSelectedConferenceId(confs[0].id);
        }
      }
    } catch {
      // ignore
    }
  };

  const loadEligibility = async (confId) => {
    if (!confId) return;
    setLoadingEligibility(true);
    setClaimMessage({ text: '', type: '' });
    try {
      const res = await fetch(`${API}/api/conferences/${confId}/certificates/eligibility`, { credentials: 'include' });
      if (res.ok) {
        const json = await res.json();
        setEligibilityData(json.data);
      } else {
        setEligibilityData(null);
      }
    } catch {
      setEligibilityData(null);
    } finally {
      setLoadingEligibility(false);
    }
  };

  useEffect(() => {
    loadMyCertificates();
    loadConferences();
  }, []);

  useEffect(() => {
    if (tab === 'claim' && selectedConferenceId) {
      loadEligibility(selectedConferenceId);
    }
  }, [tab, selectedConferenceId]);

  const handleDownload = (certId, certNumber) => {
    const downloadUrl = `${API}/api/certificates/${certId}/download`;
    // Trigger direct browser download
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.target = '_blank';
    link.download = `${certNumber || 'certificate'}.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleClaim = async (type) => {
    setClaimingType(type);
    setClaimMessage({ text: '', type: '' });
    try {
      const csrf = await fetchCsrf();
      const res = await fetch(`${API}/api/conferences/${selectedConferenceId}/certificates/claim`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify({ certificate_type: type }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error?.message || 'Could not claim certificate');
      }
      setClaimMessage({
        text: `Successfully issued ${type} certificate (${json.data?.certificate?.certificate_number})!`,
        type: 'success',
      });
      // Refresh eligibility and certificate list
      loadEligibility(selectedConferenceId);
      loadMyCertificates();
    } catch (err) {
      setClaimMessage({ text: err.message, type: 'error' });
    } finally {
      setClaimingType(null);
    }
  };

  return (
    <div className="cert-container">
      <div className="page-title" style={{ padding: '20px 0' }}>
        <p className="eyebrow">ACADEMIC RECOGNITION</p>
        <h1>Certificates</h1>
        <p className="page-lead">
          Official, digitally verifiable certificates for attendance, presentations, peer reviews, authored papers, and event organization.
        </p>
      </div>

      <div className="cert-tabs">
        <button
          type="button"
          className={`cert-tab-btn ${tab === 'my' ? 'active' : ''}`}
          onClick={() => setTab('my')}
        >
          My Certificates ({myCertificates.length})
        </button>
        <button
          type="button"
          className={`cert-tab-btn ${tab === 'claim' ? 'active' : ''}`}
          onClick={() => setTab('claim')}
        >
          Check Eligibility & Claim
        </button>
      </div>

      {tab === 'my' && (
        <section>
          {loadingMy ? (
            <div className="state-box" role="status">
              <span className="spinner" /> Loading your certificates…
            </div>
          ) : errorMy ? (
            <div className="state-box state-error" role="alert">
              <strong>Error loading certificates</strong>
              <p>{errorMy}</p>
              <button className="button button-outline" type="button" onClick={loadMyCertificates}>
                Try again
              </button>
            </div>
          ) : myCertificates.length === 0 ? (
            <div className="state-box empty-state">
              <span className="empty-icon">✳</span>
              <h2>No certificates issued yet</h2>
              <p>
                You haven't claimed any certificates yet. Check your eligibility for any attended or participating conference!
              </p>
              <button className="button button-green" type="button" onClick={() => setTab('claim')}>
                Check Certificate Eligibility
              </button>
            </div>
          ) : (
            <div className="cert-grid">
              {myCertificates.map((cert) => (
                <article key={cert.id} className={`cert-card ${cert.is_revoked ? 'revoked' : ''}`}>
                  <div className="cert-card-top">
                    <span className={`cert-badge ${cert.certificate_type}`}>
                      {cert.certificate_type}
                    </span>
                    <span className={cert.is_revoked ? 'status-pill-revoked' : 'status-pill-active'}>
                      {cert.is_revoked ? 'Revoked' : 'Verified & Active'}
                    </span>
                  </div>

                  <div className="cert-number">{cert.certificate_number}</div>
                  <h3 className="cert-conf-title">{cert.conference_title || 'BUP Conference'}</h3>

                  <div className="cert-meta">
                    Issued to <strong>{cert.recipient_name || user?.fullName}</strong>
                    <br />
                    Issued on {new Date(cert.issued_at).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                  </div>

                  {cert.is_revoked && (
                    <div className="cert-revocation-note">
                      <strong>Certificate Revoked:</strong> {cert.revocation_reason || 'Administrative action'}
                    </div>
                  )}

                  <div className="cert-actions">
                    <button
                      type="button"
                      className="button button-green"
                      style={{ padding: '8px 14px', fontSize: '11px' }}
                      onClick={() => handleDownload(cert.id, cert.certificate_number)}
                    >
                      Download PDF ⤓
                    </button>
                    <a
                      className="button button-outline"
                      style={{ padding: '8px 14px', fontSize: '11px' }}
                      href={`/certificate-verification?number=${encodeURIComponent(cert.certificate_number)}`}
                    >
                      Verify Status ↗
                    </a>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'claim' && (
        <section>
          <div style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <label htmlFor="conf-select" style={{ fontWeight: 600, fontSize: '0.9rem', color: '#334155' }}>
              Select Conference:
            </label>
            <select
              id="conf-select"
              value={selectedConferenceId}
              onChange={(e) => setSelectedConferenceId(e.target.value)}
              style={{
                padding: '0.5rem 0.75rem',
                border: '1px solid #cbd5e1',
                borderRadius: '6px',
                fontSize: '0.9rem',
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

          {claimMessage.text && (
            <div
              className={`form-message ${claimMessage.type === 'success' ? 'success' : 'error'}`}
              style={{ marginBottom: '1.5rem' }}
            >
              {claimMessage.text}
            </div>
          )}

          {loadingEligibility ? (
            <div className="state-box" role="status">
              <span className="spinner" /> Evaluating your certificate eligibility…
            </div>
          ) : !eligibilityData ? (
            <div className="state-box empty-state">
              <h2>Select a conference</h2>
              <p>Choose an announced conference from the dropdown above to inspect your eligibility criteria.</p>
            </div>
          ) : (
            <div>
              <p style={{ color: '#64748b', fontSize: '0.9rem', marginBottom: '1rem' }}>
                Rules are verified directly from real database records (confirmed registrations, verified attendance, peer reviews, accepted papers, and organizer roles).
              </p>

              <div className="eligibility-grid">
                {Object.entries(eligibilityData.eligibility || {}).map(([type, status]) => (
                  <div
                    key={type}
                    className={`eligibility-card ${
                      status.claimed ? 'claimed' : status.eligible ? 'eligible' : ''
                    }`}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                      <span className={`cert-badge ${type}`}>{type}</span>
                      <span
                        className={`eligibility-status-tag ${
                          status.claimed ? 'claimed' : status.eligible ? 'yes' : 'no'
                        }`}
                      >
                        {status.claimed ? 'Claimed' : status.eligible ? 'Eligible' : 'Not Eligible'}
                      </span>
                    </div>

                    <h4 style={{ margin: '0 0 0.5rem', fontSize: '1rem', textTransform: 'capitalize' }}>
                      {type} Certificate
                    </h4>

                    <p style={{ fontSize: '0.825rem', color: '#64748b', lineHeight: 1.5, margin: '0 0 1rem' }}>
                      {status.reason}
                    </p>

                    <div style={{ marginTop: 'auto' }}>
                      {status.claimed ? (
                        <div style={{ fontSize: '0.8rem', color: '#475569', fontWeight: 600 }}>
                          ✓ Certificate already issued
                          {status.certificate && (
                            <div style={{ marginTop: '0.5rem' }}>
                              <button
                                type="button"
                                className="button button-outline"
                                style={{ padding: '6px 12px', fontSize: '11px', width: '100%' }}
                                onClick={() => handleDownload(status.certificate.id, status.certificate.certificate_number)}
                              >
                                Download Certificate ⤓
                              </button>
                            </div>
                          )}
                        </div>
                      ) : status.eligible ? (
                        <button
                          type="button"
                          className="button button-green button-full"
                          style={{ padding: '8px 12px', fontSize: '11px' }}
                          disabled={claimingType === type}
                          onClick={() => handleClaim(type)}
                        >
                          {claimingType === type ? 'Issuing…' : 'Claim Certificate ↗'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="button button-outline button-full"
                          style={{ padding: '8px 12px', fontSize: '11px', opacity: 0.5, cursor: 'not-allowed' }}
                          disabled
                        >
                          Requirements Not Met
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

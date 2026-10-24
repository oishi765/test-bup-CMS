import { useEffect, useState } from 'react';
import './registration.css';

const API = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

async function call(path, options = {}) {
  const res = await fetch(`${API}${path}`, { credentials: 'include', ...options });
  const result = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(result?.error?.message || `Request failed (${res.status})`);
  return result.data ?? result;
}

async function csrf() {
  const result = await call('/api/auth/csrf');
  return result.csrfToken;
}

async function jsonMutation(path, method, body) {
  const token = await csrf();
  return call(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    body: JSON.stringify(body),
  });
}

async function fileMutation(path, form) {
  const token = await csrf();
  return call(path, {
    method: 'POST',
    headers: { 'X-CSRF-Token': token },
    body: form,
  });
}

export default function RegistrationPage({ user }) {
  const [conferences, setConferences] = useState([]);
  const [selectedConferenceId, setSelectedConferenceId] = useState('');
  const [conferenceInfo, setConferenceInfo] = useState(null);
  const [myRegistrations, setMyRegistrations] = useState([]);
  const [myPapers, setMyPapers] = useState([]);
  const [activeTab, setActiveTab] = useState('register'); // 'register' | 'my'
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Register Modal state
  const [showRegModal, setShowRegModal] = useState(false);
  const [selectedTier, setSelectedTier] = useState(null);
  const [regForm, setRegForm] = useState({
    paperId: '',
    organization: user?.institution || '',
    dietaryRequirements: '',
    specialNeeds: '',
  });

  // Receipt Modal state
  const [receiptTarget, setReceiptTarget] = useState(null);
  const [receiptForm, setReceiptForm] = useState({
    paymentMethod: 'bank_transfer',
    transactionReference: '',
  });

  // Cancel / Refund Modal state
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelReason, setCancelReason] = useState('');
  const [refundTarget, setRefundTarget] = useState(null);
  const [refundReason, setRefundReason] = useState('');

  async function loadInitial() {
    setLoading(true);
    setError('');
    try {
      const confs = await call('/api/conferences?limit=100');
      setConferences(confs);
      const initialId = new URLSearchParams(window.location.search).get('conferenceId') || (confs[0]?.id || '');
      setSelectedConferenceId(initialId);
      if (user) {
        const [regs, papers] = await Promise.all([
          call('/api/registrations/my').catch(() => []),
          call('/api/author/submissions').catch(() => []),
        ]);
        setMyRegistrations(regs);
        setMyPapers(papers);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadInitial();
  }, []);

  async function loadConferenceDetails(confId) {
    if (!confId) {
      setConferenceInfo(null);
      return;
    }
    try {
      const info = await call(`/api/conferences/${confId}/registration-tiers`);
      setConferenceInfo(info);
    } catch (e) {
      setError(e.message);
      setConferenceInfo(null);
    }
  }

  useEffect(() => {
    if (selectedConferenceId) {
      loadConferenceDetails(selectedConferenceId);
    }
  }, [selectedConferenceId]);

  async function handleRegister(e) {
    e.preventDefault();
    if (!user) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
      return;
    }
    if (!selectedTier) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const body = {
        category: selectedTier.category,
        paperId: selectedTier.category === 'author' ? regForm.paperId || null : null,
        organization: regForm.organization || null,
        dietaryRequirements: regForm.dietaryRequirements || null,
        specialNeeds: regForm.specialNeeds || null,
      };
      const result = await jsonMutation(`/api/conferences/${selectedConferenceId}/registrations`, 'POST', body);
      setNotice(`Registration successful! Your reference code is ${result.referenceCode}. Please upload your payment receipt below.`);
      setShowRegModal(false);
      const regs = await call('/api/registrations/my');
      setMyRegistrations(regs);
      setActiveTab('my');
      await loadConferenceDetails(selectedConferenceId);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleUploadReceipt(e) {
    e.preventDefault();
    const fileInput = e.currentTarget.elements.receiptFile;
    if (!fileInput?.files?.[0]) {
      setError('Please choose a receipt file (PDF, JPG, or PNG).');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const data = new FormData();
      data.set('paymentMethod', receiptForm.paymentMethod);
      data.set('transactionReference', receiptForm.transactionReference);
      data.set('receipt', fileInput.files[0]);

      await fileMutation(`/api/registrations/${receiptTarget.id}/receipt`, data);
      setNotice('Payment receipt uploaded successfully! It is now in the organizer verification queue.');
      setReceiptTarget(null);
      setReceiptForm({ paymentMethod: 'bank_transfer', transactionReference: '' });
      const regs = await call('/api/registrations/my');
      setMyRegistrations(regs);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDownloadReceipt(regId) {
    setError('');
    try {
      const res = await jsonMutation(`/api/registrations/${regId}/receipt-link`, 'POST', {});
      window.open(res.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleCancelRegistration(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await jsonMutation(`/api/registrations/${cancelTarget.id}/cancellation-request`, 'POST', { reason: cancelReason });
      setNotice(res.message);
      setCancelTarget(null);
      setCancelReason('');
      const regs = await call('/api/registrations/my');
      setMyRegistrations(regs);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRefundRequest(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await jsonMutation(`/api/registrations/${refundTarget.id}/refund-request`, 'POST', { reason: refundReason });
      setNotice('Refund request submitted to conference organizers.');
      setRefundTarget(null);
      setRefundReason('');
      const regs = await call('/api/registrations/my');
      setMyRegistrations(regs);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="reg-workspace">
      <header className="reg-heading">
        <div>
          <p className="eyebrow">BUP CMS · PARTICIPATION</p>
          <h1>Conference registration & payment</h1>
          <p>Register for conferences, view fee categories, and submit verified offline payments.</p>
        </div>
        {user && (
          <div className="reg-actions">
            <button
              className={`button ${activeTab === 'register' ? 'button-green' : 'button-outline'}`}
              onClick={() => setActiveTab('register')}
            >
              Available tiers
            </button>
            <button
              className={`button ${activeTab === 'my' ? 'button-green' : 'button-outline'}`}
              onClick={() => setActiveTab('my')}
            >
              My registrations ({myRegistrations.length})
            </button>
          </div>
        )}
      </header>

      {error && <div className="reg-alert" role="alert">{error}</div>}
      {notice && <div className="reg-success" role="status">{notice}</div>}

      {/* Select Conference */}
      <section className="reg-panel">
        <label style={{ display: 'grid', gap: '8px', fontSize: '13px', fontWeight: 600, color: '#2e4234' }}>
          Selected conference
          <select
            style={{ padding: '10px 12px', border: '1px solid #dce5de', borderRadius: '4px', maxWidth: '500px' }}
            value={selectedConferenceId}
            onChange={(e) => setSelectedConferenceId(e.target.value)}
          >
            {conferences.map((c) => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </select>
        </label>
      </section>

      {/* TAB 1: AVAILABLE TIERS & REGISTRATION */}
      {activeTab === 'register' && (
        <section className="reg-panel">
          {loading ? (
            <p>Loading conference registration information…</p>
          ) : !conferenceInfo ? (
            <p>No registration information available for this conference.</p>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                <div>
                  <h2>{conferenceInfo.conferenceTitle}</h2>
                  <p style={{ margin: 0, color: '#66776b', fontSize: '13px' }}>
                    Capacity: {conferenceInfo.maxCapacity ? `${conferenceInfo.totalRegistered} / ${conferenceInfo.maxCapacity} spots filled` : `${conferenceInfo.totalRegistered} registered (Unlimited capacity)`}
                  </p>
                </div>
                {conferenceInfo.isFull && (
                  <span className="badge-status badge-rejected" style={{ fontSize: '12px', padding: '6px 12px' }}>
                    Conference capacity reached
                  </span>
                )}
              </div>

              <div className="tier-grid">
                {conferenceInfo.tiers?.map((tier) => (
                  <article key={tier.id} className="tier-card">
                    <span style={{ fontSize: '11px', textTransform: 'uppercase', color: '#4b7c5b', fontWeight: 600 }}>
                      {tier.category.replaceAll('_', ' ')}
                    </span>
                    <h3>{tier.title}</h3>
                    <div className="tier-price">
                      {tier.currency} {tier.amount}
                      <small> / attendee</small>
                    </div>
                    <p className="tier-desc">{tier.description || 'Standard registration access.'}</p>
                    <div className="tier-meta">
                      {tier.eligibility_criteria && (
                        <span><strong>Eligibility:</strong> {tier.eligibility_criteria}</span>
                      )}
                      <span>
                        <strong>Deadline:</strong>{' '}
                        {tier.deadline_at ? new Date(tier.deadline_at).toLocaleDateString() : 'Until conference start'}
                        {tier.isDeadlinePassed && ' (Expired)'}
                      </span>
                      {tier.capacity && (
                        <span><strong>Category cap:</strong> {tier.capacity} participants</span>
                      )}
                    </div>
                    <button
                      className="button button-green button-full"
                      disabled={conferenceInfo.isFull || tier.isDeadlinePassed}
                      onClick={() => {
                        setSelectedTier(tier);
                        setShowRegModal(true);
                      }}
                    >
                      {tier.isDeadlinePassed ? 'Deadline passed' : conferenceInfo.isFull ? 'Capacity full' : 'Register in this tier'}
                    </button>
                  </article>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {/* TAB 2: MY REGISTRATIONS & RECEIPT MANAGEMENT */}
      {activeTab === 'my' && (
        <section className="reg-panel">
          <h2>My conference registrations</h2>
          {!myRegistrations.length ? (
            <p style={{ color: '#77887d' }}>You have not registered for any conferences yet.</p>
          ) : (
            myRegistrations.map((reg) => (
              <article key={reg.id} className="reg-card">
                <div className="reg-card-head">
                  <div>
                    <strong>{reg.reference_code}</strong>
                    <span style={{ marginLeft: '12px', color: '#4a6052', fontSize: '14px' }}>
                      {reg.conference_title}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <span className={`badge-status badge-${reg.status}`}>
                      Reg: {reg.status.replaceAll('_', ' ')}
                    </span>
                    <span className={`badge-status badge-${reg.payment_status}`}>
                      Payment: {reg.payment_status.replaceAll('_', ' ')}
                    </span>
                  </div>
                </div>

                <div className="reg-info-row">
                  <div>
                    <span>Category</span>
                    <strong>{reg.tier_title || reg.category}</strong>
                  </div>
                  <div>
                    <span>Fee amount</span>
                    <strong>{reg.tier_currency || 'BDT'} {reg.tier_amount || reg.payment_amount || 0}</strong>
                  </div>
                  <div>
                    <span>Registration date</span>
                    <strong>{new Date(reg.registered_at).toLocaleDateString()}</strong>
                  </div>
                  <div>
                    <span>Venue</span>
                    <strong>{reg.venue || 'BUP Main Campus'}</strong>
                  </div>
                </div>

                {reg.rejection_reason && (
                  <div className="reg-alert" style={{ margin: '8px 0', padding: '10px 14px' }}>
                    <strong>Receipt not verified:</strong> {reg.rejection_reason}
                  </div>
                )}

                {reg.transaction_reference && (
                  <div style={{ fontSize: '12px', color: '#556658', background: '#f7faf7', padding: '8px 12px', borderRadius: '4px' }}>
                    <span>Recorded Payment: <strong>{reg.payment_method?.replaceAll('_', ' ')}</strong> (TrxID: <strong>{reg.transaction_reference}</strong>)</span>
                    {reg.receipt_filename && (
                      <button
                        className="text-link-button"
                        style={{ marginLeft: '16px' }}
                        onClick={() => handleDownloadReceipt(reg.id)}
                      >
                        View uploaded receipt
                      </button>
                    )}
                  </div>
                )}

                <div className="reg-actions">
                  {['unpaid', 'rejected'].includes(reg.payment_status) && reg.status !== 'cancelled' && (
                    <button
                      className="button button-green"
                      onClick={() => {
                        setReceiptTarget(reg);
                        setReceiptForm({ paymentMethod: 'bank_transfer', transactionReference: '' });
                      }}
                    >
                      {reg.payment_status === 'rejected' ? 'Re-upload corrected receipt' : 'Upload payment receipt'}
                    </button>
                  )}
                  {reg.payment_status === 'verified' && !reg.refund_status && (
                    <button
                      className="button button-outline"
                      onClick={() => {
                        setRefundTarget(reg);
                        setRefundReason('');
                      }}
                    >
                      Request refund
                    </button>
                  )}
                  {reg.refund_status && (
                    <span className="badge-status badge-refund_requested">
                      Refund: {reg.refund_status} ({reg.tier_currency} {reg.refund_amount})
                    </span>
                  )}
                  {['pending', 'confirmed'].includes(reg.status) && (
                    <button
                      className="button button-outline"
                      style={{ color: '#a83232', borderColor: '#f0c0c0' }}
                      onClick={() => {
                        setCancelTarget(reg);
                        setCancelReason('');
                      }}
                    >
                      Cancel registration
                    </button>
                  )}
                </div>
              </article>
            ))
          )}
        </section>
      )}

      {/* REGISTRATION FORM MODAL */}
      {showRegModal && selectedTier && (
        <div className="reg-modal-backdrop" onClick={() => setShowRegModal(false)}>
          <div className="reg-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Register for {conferenceInfo?.conferenceTitle}</h2>
            <p style={{ color: '#55685a', fontSize: '13px' }}>
              Selected Category: <strong>{selectedTier.title}</strong> ({selectedTier.currency} {selectedTier.amount})
            </p>
            <form onSubmit={handleRegister}>
              {selectedTier.category === 'author' && (
                <div className="reg-form-group">
                  <label htmlFor="reg-paper">Accepted Paper Code / Title</label>
                  <select
                    id="reg-paper"
                    required
                    value={regForm.paperId}
                    onChange={(e) => setRegForm({ ...regForm, paperId: e.target.value })}
                  >
                    <option value="">Select your accepted paper</option>
                    {myPapers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.paper_code || 'Paper'} - {p.title}
                      </option>
                    ))}
                  </select>
                  <small>Author rates apply only to authors with accepted submissions.</small>
                </div>
              )}
              <div className="reg-form-group">
                <label htmlFor="reg-org">Organization / University / Company</label>
                <input
                  id="reg-org"
                  type="text"
                  maxLength={200}
                  value={regForm.organization}
                  onChange={(e) => setRegForm({ ...regForm, organization: e.target.value })}
                  placeholder="e.g. Bangladesh University of Professionals"
                />
              </div>
              <div className="reg-form-group">
                <label htmlFor="reg-diet">Dietary Requirements</label>
                <input
                  id="reg-diet"
                  type="text"
                  maxLength={300}
                  value={regForm.dietaryRequirements}
                  onChange={(e) => setRegForm({ ...regForm, dietaryRequirements: e.target.value })}
                  placeholder="e.g. Halal, Vegetarian, None"
                />
              </div>
              <div className="reg-form-group">
                <label htmlFor="reg-needs">Special Accessibility or Assistance Needs</label>
                <textarea
                  id="reg-needs"
                  rows={2}
                  maxLength={500}
                  value={regForm.specialNeeds}
                  onChange={(e) => setRegForm({ ...regForm, specialNeeds: e.target.value })}
                  placeholder="Any accessibility requirements or mobility support"
                />
              </div>
              <div className="reg-modal-footer">
                <button type="button" className="button button-outline" onClick={() => setShowRegModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="button button-green" disabled={busy}>
                  {busy ? 'Registering…' : `Confirm registration (${selectedTier.currency} ${selectedTier.amount})`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* UPLOAD RECEIPT MODAL */}
      {receiptTarget && (
        <div className="reg-modal-backdrop" onClick={() => setReceiptTarget(null)}>
          <div className="reg-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Upload payment receipt</h2>
            <p style={{ color: '#55685a', fontSize: '13px' }}>
              Registration Ref: <strong>{receiptTarget.reference_code}</strong> | Required Fee:{' '}
              <strong>{receiptTarget.tier_currency || 'BDT'} {receiptTarget.tier_amount || receiptTarget.payment_amount}</strong>
            </p>
            <form onSubmit={handleUploadReceipt}>
              <div className="reg-form-group">
                <label htmlFor="pm-select">Payment Method</label>
                <select
                  id="pm-select"
                  value={receiptForm.paymentMethod}
                  onChange={(e) => setReceiptForm({ ...receiptForm, paymentMethod: e.target.value })}
                >
                  <option value="bank_transfer">Bank Deposit / Wire Transfer</option>
                  <option value="mobile_banking">Mobile Banking (bKash / Nagad / Rocket)</option>
                  <option value="cash">Institutional Cash Desk</option>
                  <option value="other">Other Official Channel</option>
                </select>
              </div>
              <div className="reg-form-group">
                <label htmlFor="trx-ref">Transaction Reference / Deposit Slip / TrxID</label>
                <input
                  id="trx-ref"
                  type="text"
                  required
                  minLength={3}
                  maxLength={100}
                  value={receiptForm.transactionReference}
                  onChange={(e) => setReceiptForm({ ...receiptForm, transactionReference: e.target.value })}
                  placeholder="e.g. BKASH-TRX-8823194 or Bank Scroll No."
                />
                <small>This reference will be verified against the official BUP account statement.</small>
              </div>
              <div className="reg-form-group">
                <label htmlFor="receipt-file">Receipt Document (PDF, JPEG, or PNG, max 5 MB)</label>
                <input
                  id="receipt-file"
                  name="receiptFile"
                  type="file"
                  required
                  accept="application/pdf,image/jpeg,image/png"
                />
              </div>
              <div className="reg-modal-footer">
                <button type="button" className="button button-outline" onClick={() => setReceiptTarget(null)}>
                  Close
                </button>
                <button type="submit" className="button button-green" disabled={busy}>
                  {busy ? 'Uploading…' : 'Submit receipt for verification'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CANCELLATION REQUEST MODAL */}
      {cancelTarget && (
        <div className="reg-modal-backdrop" onClick={() => setCancelTarget(null)}>
          <div className="reg-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Cancel registration</h2>
            <p style={{ color: '#55685a', fontSize: '13px' }}>
              Reference: <strong>{cancelTarget.reference_code}</strong>
            </p>
            <form onSubmit={handleCancelRegistration}>
              <div className="reg-form-group">
                <label htmlFor="cancel-reason">Reason for cancellation</label>
                <textarea
                  id="cancel-reason"
                  rows={3}
                  required
                  minLength={5}
                  maxLength={1000}
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  placeholder="Please state why you need to cancel this registration."
                />
              </div>
              <div className="reg-modal-footer">
                <button type="button" className="button button-outline" onClick={() => setCancelTarget(null)}>
                  Back
                </button>
                <button type="submit" className="button button-green" style={{ background: '#b91c1c' }} disabled={busy}>
                  {busy ? 'Processing…' : 'Confirm cancellation'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* REFUND REQUEST MODAL */}
      {refundTarget && (
        <div className="reg-modal-backdrop" onClick={() => setRefundTarget(null)}>
          <div className="reg-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Request payment refund</h2>
            <p style={{ color: '#55685a', fontSize: '13px' }}>
              Registration Ref: <strong>{refundTarget.reference_code}</strong> | Verified Fee:{' '}
              <strong>{refundTarget.tier_currency || 'BDT'} {refundTarget.tier_amount}</strong>
            </p>
            <form onSubmit={handleRefundRequest}>
              <div className="reg-form-group">
                <label htmlFor="refund-reason">Refund justification and account notes</label>
                <textarea
                  id="refund-reason"
                  rows={3}
                  required
                  minLength={5}
                  maxLength={1000}
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  placeholder="Explain the reason for refund. Offline refunds are reviewed by the finance committee."
                />
              </div>
              <div className="reg-modal-footer">
                <button type="button" className="button button-outline" onClick={() => setRefundTarget(null)}>
                  Close
                </button>
                <button type="submit" className="button button-green" disabled={busy}>
                  {busy ? 'Submitting…' : 'Submit refund request'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}

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

export default function RegistrationAdmin() {
  const [conferences, setConferences] = useState([]);
  const [conferenceId, setConferenceId] = useState('');
  const [activeTab, setActiveTab] = useState('registrations'); // 'registrations' | 'queue' | 'tiers' | 'reports'

  // Data states
  const [registrations, setRegistrations] = useState([]);
  const [totalRegs, setTotalRegs] = useState(0);
  const [queue, setQueue] = useState([]);
  const [tiers, setTiers] = useState([]);
  const [report, setReport] = useState(null);
  const [refunds, setRefunds] = useState([]);
  const [maxCapacity, setMaxCapacity] = useState('');

  // Filters & Search
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterPayment, setFilterPayment] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [page, setPage] = useState(1);

  // States for Modals
  const [selectedReg, setSelectedReg] = useState(null);
  const [rejectPaymentTarget, setRejectPaymentTarget] = useState(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [refundProcessTarget, setRefundProcessTarget] = useState(null);
  const [processorReference, setProcessorReference] = useState('');
  const [adminNotes, setAdminNotes] = useState('');

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function loadConferences() {
    try {
      const confs = await call('/api/admin/conferences?limit=100&sort=title&order=asc');
      setConferences(confs);
      if (confs.length && !conferenceId) setConferenceId(confs[0].id);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadConferences();
  }, []);

  async function refreshData() {
    if (!conferenceId) return;
    setLoading(true);
    setError('');
    try {
      if (activeTab === 'registrations') {
        const query = new URLSearchParams({
          q: search,
          status: filterStatus,
          paymentStatus: filterPayment,
          category: filterCategory,
          page: String(page),
          limit: '20',
        });
        const res = await call(`/api/admin/conferences/${conferenceId}/registrations?${query.toString()}`);
        setRegistrations(res || []);
        setTotalRegs(res?.length || 0);
      } else if (activeTab === 'queue') {
        const q = await call(`/api/admin/conferences/${conferenceId}/payments/verification-queue`);
        setQueue(q);
      } else if (activeTab === 'tiers') {
        const t = await call(`/api/admin/conferences/${conferenceId}/registration-tiers`);
        setTiers(t);
        const rep = await call(`/api/admin/conferences/${conferenceId}/financial-report`);
        setMaxCapacity(rep.conference?.maxCapacity || '');
      } else if (activeTab === 'reports') {
        const [rep, refList] = await Promise.all([
          call(`/api/admin/conferences/${conferenceId}/financial-report`),
          call(`/api/admin/conferences/${conferenceId}/refunds`),
        ]);
        setReport(rep);
        setRefunds(refList);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshData();
  }, [conferenceId, activeTab, page, filterStatus, filterPayment, filterCategory]);

  async function handleSearch(e) {
    e.preventDefault();
    setPage(1);
    refreshData();
  }

  async function handleVerifyPayment(paymentId, action, rejectionReason = '') {
    setBusy(true);
    setError('');
    try {
      await jsonMutation(`/api/admin/conferences/${conferenceId}/payments/${paymentId}/verify`, 'POST', {
        action,
        rejectionReason: action === 'reject' ? rejectionReason : undefined,
      });
      setNotice(action === 'approve' ? 'Payment receipt approved and registration confirmed!' : 'Payment receipt rejected and attendee notified.');
      setRejectPaymentTarget(null);
      setRejectionReason('');
      await refreshData();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveCapacity(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await jsonMutation(`/api/admin/conferences/${conferenceId}/capacity`, 'PATCH', {
        maxCapacity: maxCapacity ? Number(maxCapacity) : null,
      });
      setNotice('Conference capacity updated successfully.');
      await refreshData();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveTiers(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const payload = tiers.map((t) => ({
        category: t.category,
        title: t.title,
        description: t.description || null,
        amount: Number(t.amount),
        currency: t.currency || 'BDT',
        eligibilityCriteria: t.eligibility_criteria || null,
        deadlineAt: t.deadline_at ? new Date(t.deadline_at).toISOString() : null,
        capacity: t.capacity ? Number(t.capacity) : null,
        isActive: Boolean(t.is_active),
      }));
      await jsonMutation(`/api/admin/conferences/${conferenceId}/registration-tiers`, 'PUT', payload);
      setNotice('Registration tiers and fees saved.');
      await refreshData();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleProcessRefund(action) {
    if (!refundProcessTarget) return;
    setBusy(true);
    setError('');
    try {
      await jsonMutation(`/api/admin/conferences/${conferenceId}/refunds/${refundProcessTarget.id}/process`, 'POST', {
        action,
        processorReference: action === 'approve' ? processorReference : undefined,
        adminNotes: adminNotes || undefined,
      });
      setNotice(action === 'approve' ? 'Refund marked as processed.' : 'Refund request declined.');
      setRefundProcessTarget(null);
      setProcessorReference('');
      setAdminNotes('');
      await refreshData();
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

  return (
    <main className="reg-workspace">
      <header className="reg-heading">
        <div>
          <p className="eyebrow">BUP CMS · FINANCE & REGISTRATIONS</p>
          <h1>Registration & Payment Management</h1>
          <p>Verify attendee bank slips, manage registration caps, view financial reconciliation and audit history.</p>
        </div>
        <a className="button button-outline" href="/admin">
          Main admin workspace
        </a>
      </header>

      {error && <div className="reg-alert" role="alert">{error}</div>}
      {notice && <div className="reg-success" role="status">{notice}</div>}

      {/* Conference Switcher */}
      <section className="reg-panel" style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'grid', gap: '6px', fontSize: '13px', fontWeight: 600, color: '#2a3d30', flex: 1 }}>
          Active Conference
          <select
            style={{ padding: '9px 12px', border: '1px solid #dce5de', borderRadius: '4px' }}
            value={conferenceId}
            onChange={(e) => setConferenceId(e.target.value)}
          >
            {conferences.map((c) => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </select>
        </label>
        <button className="button button-outline" style={{ marginTop: '20px' }} onClick={refreshData} disabled={loading}>
          Refresh data
        </button>
      </section>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid #e2eae4', paddingBottom: '12px', marginBottom: '20px', overflowX: 'auto' }}>
        <button
          className={`button ${activeTab === 'registrations' ? 'button-green' : 'button-outline'}`}
          onClick={() => setActiveTab('registrations')}
        >
          Registrations roster
        </button>
        <button
          className={`button ${activeTab === 'queue' ? 'button-green' : 'button-outline'}`}
          onClick={() => setActiveTab('queue')}
        >
          Verification queue {queue.length > 0 && `(${queue.length})`}
        </button>
        <button
          className={`button ${activeTab === 'tiers' ? 'button-green' : 'button-outline'}`}
          onClick={() => setActiveTab('tiers')}
        >
          Tiers & capacity
        </button>
        <button
          className={`button ${activeTab === 'reports' ? 'button-green' : 'button-outline'}`}
          onClick={() => setActiveTab('reports')}
        >
          Financial reports & refunds
        </button>
      </div>

      {/* TAB 1: REGISTRATIONS ROSTER */}
      {activeTab === 'registrations' && (
        <section className="reg-panel">
          <form onSubmit={handleSearch} style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '18px' }}>
            <input
              type="text"
              placeholder="Search by name, email, ref code, or TrxID"
              style={{ flex: 1, minWidth: '240px', padding: '9px 12px', border: '1px solid #dce5de', borderRadius: '4px' }}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              style={{ padding: '9px 12px', border: '1px solid #dce5de', borderRadius: '4px' }}
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
            >
              <option value="">All reg statuses</option>
              <option value="pending">Pending</option>
              <option value="confirmed">Confirmed</option>
              <option value="cancellation_requested">Cancellation requested</option>
              <option value="cancelled">Cancelled</option>
              <option value="refunded">Refunded</option>
            </select>
            <select
              style={{ padding: '9px 12px', border: '1px solid #dce5de', borderRadius: '4px' }}
              value={filterPayment}
              onChange={(e) => setFilterPayment(e.target.value)}
            >
              <option value="">All payment statuses</option>
              <option value="unpaid">Unpaid</option>
              <option value="submitted">Submitted (In Queue)</option>
              <option value="verified">Verified</option>
              <option value="rejected">Rejected</option>
              <option value="refund_requested">Refund requested</option>
              <option value="refunded">Refunded</option>
            </select>
            <select
              style={{ padding: '9px 12px', border: '1px solid #dce5de', borderRadius: '4px' }}
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
            >
              <option value="">All categories</option>
              <option value="author">Author</option>
              <option value="student">Student</option>
              <option value="professional">Professional</option>
              <option value="general_attendee">General attendee</option>
            </select>
            <button className="button button-green" type="submit">Filter</button>
          </form>

          {loading ? (
            <p>Loading registrations roster…</p>
          ) : !registrations.length ? (
            <p style={{ color: '#77887d' }}>No registrations matched your filter criteria.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'left' }}>
                <thead>
                  <tr style={{ background: '#f5faf6', borderBottom: '2px solid #e0eae3' }}>
                    <th style={{ padding: '10px 12px' }}>Ref code</th>
                    <th style={{ padding: '10px 12px' }}>Registrant</th>
                    <th style={{ padding: '10px 12px' }}>Category</th>
                    <th style={{ padding: '10px 12px' }}>Amount</th>
                    <th style={{ padding: '10px 12px' }}>Reg status</th>
                    <th style={{ padding: '10px 12px' }}>Payment</th>
                    <th style={{ padding: '10px 12px' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {registrations.map((r) => (
                    <tr key={r.id} style={{ borderBottom: '1px solid #edf2ee' }}>
                      <td style={{ padding: '10px 12px', fontWeight: 600 }}>{r.reference_code}</td>
                      <td style={{ padding: '10px 12px' }}>
                        <strong>{r.registrant_name}</strong>
                        <div style={{ fontSize: '11px', color: '#68776d' }}>{r.registrant_email}</div>
                        {r.organization && <div style={{ fontSize: '10px', color: '#88968d' }}>{r.organization}</div>}
                      </td>
                      <td style={{ padding: '10px 12px' }}>{r.tier_title || r.category}</td>
                      <td style={{ padding: '10px 12px', fontWeight: 600 }}>
                        {r.payment_currency || r.tier_currency || 'BDT'} {r.payment_amount || r.tier_amount}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <span className={`badge-status badge-${r.status}`}>{r.status.replaceAll('_', ' ')}</span>
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <span className={`badge-status badge-${r.payment_status}`}>{r.payment_status.replaceAll('_', ' ')}</span>
                        {r.transaction_reference && (
                          <div style={{ fontSize: '10px', color: '#556658', marginTop: '2px' }}>Trx: {r.transaction_reference}</div>
                        )}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <button
                          className="button button-outline"
                          style={{ padding: '5px 9px', fontSize: '11px' }}
                          onClick={() => setSelectedReg(r)}
                        >
                          View info
                        </button>
                        {r.receipt_filename && (
                          <button
                            className="text-link-button"
                            style={{ marginLeft: '8px', fontSize: '11px' }}
                            onClick={() => handleDownloadReceipt(r.id)}
                          >
                            Receipt
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* TAB 2: VERIFICATION QUEUE */}
      {activeTab === 'queue' && (
        <section className="reg-panel">
          <h2>Payment receipt verification queue</h2>
          <p style={{ color: '#66776b', fontSize: '13px', margin: '-8px 0 16px' }}>
            Verify bank deposits, mobile banking TrxIDs, and wire advices before confirming registrations.
          </p>

          {!queue.length ? (
            <div style={{ padding: '30px', textAlign: 'center', color: '#77887d', background: '#f9fbf9', borderRadius: '4px' }}>
              All submitted payment receipts have been verified!
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '16px' }}>
              {queue.map((item) => (
                <article key={item.id} className="reg-card">
                  <div className="reg-card-head">
                    <div>
                      <strong>{item.reference_code}</strong>
                      <span style={{ marginLeft: '12px', color: '#44564a' }}>
                        {item.registrant_name} ({item.registrant_email})
                      </span>
                    </div>
                    <span className="badge-status badge-submitted">Awaiting verification</span>
                  </div>

                  <div className="reg-info-row">
                    <div>
                      <span>Category</span>
                      <strong>{item.tier_title || item.category}</strong>
                    </div>
                    <div>
                      <span>Payment method</span>
                      <strong>{item.payment_method?.replaceAll('_', ' ')}</strong>
                    </div>
                    <div>
                      <span>Transaction Reference / TrxID</span>
                      <strong style={{ color: '#275638' }}>{item.transaction_reference}</strong>
                    </div>
                    <div>
                      <span>Required amount</span>
                      <strong>{item.currency} {item.amount}</strong>
                    </div>
                  </div>

                  <div className="reg-actions" style={{ alignItems: 'center' }}>
                    <button
                      className="button button-outline"
                      onClick={() => handleDownloadReceipt(item.registration_id)}
                    >
                      Download receipt document ({item.receipt_filename})
                    </button>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
                      <button
                        className="button button-green"
                        disabled={busy}
                        onClick={() => handleVerifyPayment(item.id, 'approve')}
                      >
                        Approve receipt
                      </button>
                      <button
                        className="button button-outline"
                        style={{ color: '#b91c1c', borderColor: '#fca5a5' }}
                        disabled={busy}
                        onClick={() => {
                          setRejectPaymentTarget(item);
                          setRejectionReason('');
                        }}
                      >
                        Reject receipt
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {/* TAB 3: TIERS & CAPACITY */}
      {activeTab === 'tiers' && (
        <section className="reg-panel">
          <h2>Registration tiers, fees & conference capacity</h2>

          <form onSubmit={handleSaveCapacity} style={{ display: 'flex', gap: '12px', alignItems: 'flex-end', marginBottom: '24px', paddingBottom: '16px', borderBottom: '1px solid #edf2ee' }}>
            <label style={{ display: 'grid', gap: '5px', fontSize: '12px', color: '#334438' }}>
              Overall conference max capacity (Leave blank for unlimited)
              <input
                type="number"
                min="1"
                max="100000"
                style={{ padding: '8px 12px', border: '1px solid #dce5de', borderRadius: '4px', width: '220px' }}
                value={maxCapacity}
                onChange={(e) => setMaxCapacity(e.target.value)}
                placeholder="e.g. 500"
              />
            </label>
            <button className="button button-outline" type="submit" disabled={busy}>
              Update capacity
            </button>
          </form>

          <form onSubmit={handleSaveTiers}>
            <div style={{ display: 'grid', gap: '16px', marginBottom: '20px' }}>
              {tiers.map((t, idx) => (
                <div key={t.category} style={{ border: '1px solid #e2ece5', borderRadius: '6px', padding: '16px', background: '#fafdfb' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <strong style={{ fontSize: '15px', color: '#273c2f', textTransform: 'capitalize' }}>
                      {t.category.replaceAll('_', ' ')} tier
                    </strong>
                    <label style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <input
                        type="checkbox"
                        checked={t.is_active}
                        onChange={(e) => {
                          const updated = [...tiers];
                          updated[idx].is_active = e.target.checked;
                          setTiers(updated);
                        }}
                      />
                      Active for registration
                    </label>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
                    <label style={{ fontSize: '11px', display: 'grid', gap: '4px' }}>
                      Display title
                      <input
                        type="text"
                        value={t.title}
                        onChange={(e) => {
                          const updated = [...tiers];
                          updated[idx].title = e.target.value;
                          setTiers(updated);
                        }}
                      />
                    </label>
                    <label style={{ fontSize: '11px', display: 'grid', gap: '4px' }}>
                      Fee amount
                      <input
                        type="number"
                        min="0"
                        step="100"
                        value={t.amount}
                        onChange={(e) => {
                          const updated = [...tiers];
                          updated[idx].amount = e.target.value;
                          setTiers(updated);
                        }}
                      />
                    </label>
                    <label style={{ fontSize: '11px', display: 'grid', gap: '4px' }}>
                      Currency
                      <select
                        value={t.currency}
                        onChange={(e) => {
                          const updated = [...tiers];
                          updated[idx].currency = e.target.value;
                          setTiers(updated);
                        }}
                      >
                        <option value="BDT">BDT (৳)</option>
                        <option value="USD">USD ($)</option>
                        <option value="EUR">EUR (€)</option>
                        <option value="GBP">GBP (£)</option>
                      </select>
                    </label>
                    <label style={{ fontSize: '11px', display: 'grid', gap: '4px' }}>
                      Category capacity cap
                      <input
                        type="number"
                        min="1"
                        value={t.capacity || ''}
                        onChange={(e) => {
                          const updated = [...tiers];
                          updated[idx].capacity = e.target.value ? Number(e.target.value) : null;
                          setTiers(updated);
                        }}
                        placeholder="Unlimited"
                      />
                    </label>
                    <label style={{ fontSize: '11px', display: 'grid', gap: '4px' }}>
                      Registration deadline
                      <input
                        type="datetime-local"
                        value={t.deadline_at ? new Date(t.deadline_at).toISOString().slice(0, 16) : ''}
                        onChange={(e) => {
                          const updated = [...tiers];
                          updated[idx].deadline_at = e.target.value || null;
                          setTiers(updated);
                        }}
                      />
                    </label>
                  </div>
                  <label style={{ fontSize: '11px', display: 'grid', gap: '4px', marginTop: '10px' }}>
                    Eligibility criteria instructions (shown to attendee)
                    <input
                      type="text"
                      value={t.eligibility_criteria || ''}
                      onChange={(e) => {
                        const updated = [...tiers];
                        updated[idx].eligibility_criteria = e.target.value;
                        setTiers(updated);
                      }}
                      placeholder="e.g. Valid student identification required"
                    />
                  </label>
                </div>
              ))}
            </div>
            <button className="button button-green" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save all tier configurations'}
            </button>
          </form>
        </section>
      )}

      {/* TAB 4: FINANCIAL REPORTS & REFUNDS */}
      {activeTab === 'reports' && report && (
        <section className="reg-panel">
          <h2>Financial reconciliation & reports</h2>

          <div className="reg-stats-grid">
            {report.revenueByCurrency?.map((curr) => (
              <div key={curr.currency} className="reg-stat-card">
                <span>Verified gross ({curr.currency})</span>
                <strong>{curr.currency} {curr.verified_total}</strong>
                <small>{curr.verified_count} verified payments</small>
              </div>
            ))}
            <div className="reg-stat-card">
              <span>Pending verification</span>
              <strong>{report.revenueByCurrency?.[0]?.pending_total || 0}</strong>
              <small>{report.revenueByCurrency?.[0]?.pending_count || 0} receipts in queue</small>
            </div>
            <div className="reg-stat-card">
              <span>Capacity utilization</span>
              <strong>
                {report.conference?.activeRegistrations} / {report.conference?.maxCapacity || '∞'}
              </strong>
              <small>{report.conference?.remainingCapacity !== null ? `${report.conference.remainingCapacity} spots remaining` : 'Unlimited capacity'}</small>
            </div>
          </div>

          <h3>Revenue by attendee category</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'left', marginBottom: '24px' }}>
            <thead>
              <tr style={{ background: '#f5faf6', borderBottom: '2px solid #e0eae3' }}>
                <th style={{ padding: '8px 12px' }}>Category</th>
                <th style={{ padding: '8px 12px' }}>Registrations</th>
                <th style={{ padding: '8px 12px' }}>Confirmed count</th>
                <th style={{ padding: '8px 12px' }}>Verified revenue</th>
              </tr>
            </thead>
            <tbody>
              {report.categoryBreakdown?.map((cat) => (
                <tr key={cat.category} style={{ borderBottom: '1px solid #edf2ee' }}>
                  <td style={{ padding: '8px 12px', textTransform: 'capitalize', fontWeight: 600 }}>{cat.category.replaceAll('_', ' ')}</td>
                  <td style={{ padding: '8px 12px' }}>{cat.total_registrations}</td>
                  <td style={{ padding: '8px 12px' }}>{cat.confirmed_count}</td>
                  <td style={{ padding: '8px 12px', fontWeight: 600 }}>BDT {cat.verified_revenue}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Refund requests management</h3>
          {!refunds.length ? (
            <p style={{ color: '#77887d' }}>No refund requests have been submitted for this conference.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'left' }}>
              <thead>
                <tr style={{ background: '#f5faf6', borderBottom: '2px solid #e0eae3' }}>
                  <th style={{ padding: '8px 12px' }}>Ref code</th>
                  <th style={{ padding: '8px 12px' }}>Registrant</th>
                  <th style={{ padding: '8px 12px' }}>Amount</th>
                  <th style={{ padding: '8px 12px' }}>Reason</th>
                  <th style={{ padding: '8px 12px' }}>Status</th>
                  <th style={{ padding: '8px 12px' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {refunds.map((ref) => (
                  <tr key={ref.id} style={{ borderBottom: '1px solid #edf2ee' }}>
                    <td style={{ padding: '8px 12px', fontWeight: 600 }}>{ref.reference_code}</td>
                    <td style={{ padding: '8px 12px' }}>{ref.registrant_name} ({ref.registrant_email})</td>
                    <td style={{ padding: '8px 12px', fontWeight: 600 }}>{ref.currency} {ref.amount}</td>
                    <td style={{ padding: '8px 12px', maxWidth: '240px' }}>{ref.reason}</td>
                    <td style={{ padding: '8px 12px' }}>
                      <span className={`badge-status badge-${ref.status}`}>{ref.status}</span>
                      {ref.processor_reference && <div style={{ fontSize: '10px', color: '#556658' }}>Ref: {ref.processor_reference}</div>}
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      {ref.status === 'requested' && (
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button
                            className="button button-green"
                            style={{ padding: '4px 8px', fontSize: '11px' }}
                            onClick={() => {
                              setRefundProcessTarget(ref);
                              setProcessorReference('');
                              setAdminNotes('');
                            }}
                          >
                            Process refund
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* REGISTRATION DETAIL MODAL */}
      {selectedReg && (
        <div className="reg-modal-backdrop" onClick={() => setSelectedReg(null)}>
          <div className="reg-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Registration details: {selectedReg.reference_code}</h2>
            <div style={{ display: 'grid', gap: '10px', fontSize: '13px', margin: '16px 0' }}>
              <div><strong>Registrant:</strong> {selectedReg.registrant_name} ({selectedReg.registrant_email})</div>
              <div><strong>Organization:</strong> {selectedReg.organization || 'None specified'}</div>
              <div><strong>Tier / Category:</strong> {selectedReg.tier_title || selectedReg.category}</div>
              <div><strong>Status:</strong> {selectedReg.status} | <strong>Payment:</strong> {selectedReg.payment_status}</div>
              <div><strong>Dietary requirements:</strong> {selectedReg.dietary_requirements || 'None'}</div>
              <div><strong>Special assistance needs:</strong> {selectedReg.special_needs || 'None'}</div>
              {selectedReg.transaction_reference && (
                <div><strong>Transaction Reference / TrxID:</strong> {selectedReg.transaction_reference}</div>
              )}
              {selectedReg.cancellation_reason && (
                <div style={{ color: '#b91c1c' }}><strong>Cancellation reason:</strong> {selectedReg.cancellation_reason}</div>
              )}
            </div>
            <div className="reg-modal-footer">
              {selectedReg.receipt_filename && (
                <button
                  type="button"
                  className="button button-outline"
                  onClick={() => handleDownloadReceipt(selectedReg.id)}
                >
                  Download receipt document
                </button>
              )}
              <button type="button" className="button button-green" onClick={() => setSelectedReg(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* REJECT RECEIPT MODAL */}
      {rejectPaymentTarget && (
        <div className="reg-modal-backdrop" onClick={() => setRejectPaymentTarget(null)}>
          <div className="reg-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Reject payment receipt</h2>
            <p style={{ color: '#55685a', fontSize: '13px' }}>
              Registration: <strong>{rejectPaymentTarget.reference_code}</strong> | TrxID:{' '}
              <strong>{rejectPaymentTarget.transaction_reference}</strong>
            </p>
            <form onSubmit={(e) => { e.preventDefault(); handleVerifyPayment(rejectPaymentTarget.id, 'reject', rejectionReason); }}>
              <div className="reg-form-group">
                <label htmlFor="rej-reason">Rejection reason (sent to attendee)</label>
                <textarea
                  id="rej-reason"
                  rows={3}
                  required
                  minLength={5}
                  maxLength={1000}
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  placeholder="Explain why this receipt was not accepted (e.g. TrxID not matched on bank statement, illegible image, incorrect amount)."
                />
              </div>
              <div className="reg-modal-footer">
                <button type="button" className="button button-outline" onClick={() => setRejectPaymentTarget(null)}>
                  Cancel
                </button>
                <button type="submit" className="button button-green" style={{ background: '#b91c1c' }} disabled={busy}>
                  {busy ? 'Rejecting…' : 'Confirm rejection'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* PROCESS REFUND MODAL */}
      {refundProcessTarget && (
        <div className="reg-modal-backdrop" onClick={() => setRefundProcessTarget(null)}>
          <div className="reg-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Process offline bank refund</h2>
            <p style={{ color: '#55685a', fontSize: '13px' }}>
              Ref: <strong>{refundProcessTarget.reference_code}</strong> | Amount:{' '}
              <strong>{refundProcessTarget.currency} {refundProcessTarget.amount}</strong>
            </p>
            <form onSubmit={(e) => { e.preventDefault(); handleProcessRefund('approve'); }}>
              <div className="reg-form-group">
                <label htmlFor="ref-tx">Bank / Mobile Banking Refund Transaction Reference</label>
                <input
                  id="ref-tx"
                  type="text"
                  required
                  minLength={3}
                  maxLength={100}
                  value={processorReference}
                  onChange={(e) => setProcessorReference(e.target.value)}
                  placeholder="e.g. BANK-REFUND-TX-9988221"
                />
                <small>Record the confirmed reference from the institution's bank/mobile banking portal.</small>
              </div>
              <div className="reg-form-group">
                <label htmlFor="ref-notes">Internal finance committee notes (optional)</label>
                <textarea
                  id="ref-notes"
                  rows={2}
                  maxLength={1000}
                  value={adminNotes}
                  onChange={(e) => setAdminNotes(e.target.value)}
                  placeholder="Additional notes about this refund resolution."
                />
              </div>
              <div className="reg-modal-footer">
                <button
                  type="button"
                  className="button button-outline"
                  style={{ color: '#b91c1c', borderColor: '#fca5a5' }}
                  onClick={() => handleProcessRefund('reject')}
                  disabled={busy}
                >
                  Decline refund request
                </button>
                <button type="button" className="button button-outline" onClick={() => setRefundProcessTarget(null)}>
                  Close
                </button>
                <button type="submit" className="button button-green" disabled={busy}>
                  {busy ? 'Processing…' : 'Record refund as processed'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}

import React, { useEffect, useMemo, useState } from 'react';
import AdminWorkspace from './AdminWorkspace.jsx';
import AuthorSubmissions from './AuthorSubmissions.jsx';
import ReviewerWorkspace from './ReviewerWorkspace.jsx';
import ReviewAdmin from './ReviewAdmin.jsx';
import RegistrationPage from './RegistrationPage.jsx';
import RegistrationAdmin from './RegistrationAdmin.jsx';
import SchedulePage from './SchedulePage.jsx';
import ScheduleAdmin from './ScheduleAdmin.jsx';
import ChairWorkspace from './ChairWorkspace.jsx';
import CheckInPage from './CheckInPage.jsx';
import CertificatesPage from './CertificatesPage.jsx';
import CertificateAdmin from './CertificateAdmin.jsx';
import AnalyticsDashboard from './AnalyticsDashboard.jsx';
import NotificationBell from './NotificationsCenter.jsx';

const API = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ROUTES = [
  ['Home', '/'], ['About', '/about'], ['Conferences', '/conferences'], ['Important dates', '/important-dates'],
  ['Tracks', '/tracks'], ['Committee', '/committee'], ['Speakers', '/speakers'], ['Schedule', '/schedule'],
  ['Submission guidelines', '/submission-guidelines'], ['Registration information', '/registration-information'],
  ['Contact', '/contact'], ['FAQ', '/faq'], ['Login', '/login'], ['Register', '/register'],
  ['Forgot password', '/forgot-password'], ['Dashboard', '/dashboard'], ['Profile', '/profile'],
  ['Change password', '/change-password'], ['Privacy policy', '/privacy-policy'], ['Terms', '/terms'],
  ['Certificate verification', '/certificate-verification'], ['My certificates', '/certificates'],
];

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    credentials: 'include',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error?.message || `Request failed (${response.status})`);
  return result.data ?? result;
}

async function authMutation(path, body, method = 'POST') {
  const csrfResponse = await fetch(`${API}/api/auth/csrf`, { credentials: 'include' });
  const csrfResult = await csrfResponse.json().catch(() => ({}));
  if (!csrfResponse.ok) throw new Error(csrfResult?.error?.message || 'Could not initialize secure request.');
  const response = await fetch(`${API}${path}`, {
    method, credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfResult.data.csrfToken },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error?.message || `Request failed (${response.status})`);
  return result.data ?? result;
}

function useData(path) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  useEffect(() => {
    if (!path) { setState({ loading: false, data: null, error: '' }); return undefined; }
    const controller = new AbortController();
    setState({ loading: true, data: null, error: '' });
    fetch(`${API}${path}`, { signal: controller.signal, credentials: 'include' })
      .then(async (response) => {
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result?.error?.message || `Request failed (${response.status})`);
        return result.data ?? result;
      })
      .then((data) => setState({ loading: false, data, error: '' }))
      .catch((error) => { if (error.name !== 'AbortError') setState({ loading: false, data: null, error: error.message }); });
    return () => controller.abort();
  }, [path]);
  return state;
}

function Header() {
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState(null);
  const [logoutError, setLogoutError] = useState('');
  useEffect(() => { request('/api/auth/session').then((session) => setUser(session.user)).catch(() => setUser(null)); }, []);
  const primary = [['Home', '/'], ['Conferences', '/conferences'], ['Submission', '/submission-guidelines'], ['About', '/about']];
  async function logout() { setLogoutError(''); try { await authMutation('/api/auth/logout', {}); setUser(null); window.location.href = '/'; } catch (error) { setLogoutError(error.message); } }
  return <header className="site-header"><div className="header-inner"><a className="brand" href="/" aria-label="BUP Conference Management home"><img src="/logo.png" alt="Bangladesh University of Professionals"/><span>Conference<br/><b>Management</b></span></a><button className="menu-toggle" type="button" aria-label="Toggle navigation" aria-expanded={open} onClick={() => setOpen(!open)}><span/><span/><span/></button><nav className={`main-nav ${open ? 'is-open' : ''}`} aria-label="Main navigation">{primary.map(([label, href]) => <a key={href} href={href} onClick={() => setOpen(false)}>{label}</a>)}<details className="nav-more"><summary>Explore <span aria-hidden="true">⌄</span></summary><div className="nav-dropdown">{ROUTES.filter(([, href]) => !primary.some(([, primaryHref]) => href === primaryHref)).map(([label, href]) => <a key={href} href={href} onClick={() => setOpen(false)}>{label}</a>)}</div></details>{user ? <><a href="/dashboard" onClick={() => setOpen(false)}>Dashboard</a><a href="/certificates" onClick={() => setOpen(false)}>Certificates</a><NotificationBell user={user}/><button className="nav-logout" type="button" onClick={logout}>Sign out</button></> : <a className="nav-login" href="/login" onClick={() => setOpen(false)}>Sign in <span aria-hidden="true">↗</span></a>}{logoutError && <span className="nav-error" role="alert">{logoutError}</span>}</nav></div></header>;
}

function Footer() {
  return <footer className="site-footer"><div className="footer-main"><div className="footer-brand"><a href="/" aria-label="BUP Conference Management home"><img src="/logo.png" alt="BUP"/></a><p>Bangladesh University of Professionals<br/>Conference Management System</p></div><div><h3>Explore</h3><a href="/conferences">Conferences</a><a href="/important-dates">Important dates</a><a href="/schedule">Schedule</a><a href="/certificate-verification">Verify a certificate</a></div><div><h3>Information</h3><a href="/submission-guidelines">Submission guidelines</a><a href="/registration-information">Registration</a><a href="/faq">FAQ</a><a href="/contact">Contact</a></div></div><div className="footer-bottom"><span>© {new Date().getFullYear()} Bangladesh University of Professionals</span><span><a href="/privacy-policy">Privacy</a><a href="/terms">Terms</a></span></div></footer>;
}

function PageTitle({ eyebrow = 'BUP CONFERENCE MANAGEMENT', title, lead }) {
  return <div className="page-title"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{lead && <p className="page-lead">{lead}</p>}</div>;
}

function Loading({ label = 'Loading published information…' }) { return <div className="state-box" role="status"><span className="spinner"/>{label}</div>; }
function ErrorState({ message, retry }) { return <div className="state-box state-error" role="alert"><strong>We couldn’t load this information.</strong><p>{message}</p>{retry && <button className="button button-outline" type="button" onClick={retry}>Try again</button>}</div>; }
function EmptyState({ title = 'Nothing published yet', children = 'There is no public information to show here yet. Please check back later.' }) { return <div className="state-box empty-state"><span className="empty-icon" aria-hidden="true">✳</span><h2>{title}</h2><p>{children}</p><a className="text-link" href="/contact">Contact the conference team <span aria-hidden="true">→</span></a></div>; }
function useRetry(path) {
  const [version, setVersion] = useState(0);
  const retryPath = path ? `${path}${path.includes('?') ? '&' : '?'}_refresh=${version}` : '';
  return [useData(retryPath), () => setVersion(version + 1)];
}
function RequestState({ loading, error, retry, children }) {
  if (loading) return <Loading/>;
  if (error) return <ErrorState message={error} retry={retry}/>;
  return children;
}
function formatDate(value, timezone = 'Asia/Dhaka', options = { dateStyle: 'long' }) {
  if (!value) return 'Date to be announced';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date to be announced';
  return new Intl.DateTimeFormat('en', { ...options, timeZone: timezone || 'Asia/Dhaka' }).format(date);
}
function ConferenceCard({ item }) {
  return <article className="conference-card"><div className="card-topline"><span className={`pill status-${item.status}`}>{item.status.replaceAll('_', ' ')}</span><span>{item.acronym || 'BUP Conference'}</span></div><h2><a href={`/conferences/${item.id}`}>{item.title}</a></h2><p>{item.description || 'Conference details and participation information will be shared here.'}</p><div className="card-meta"><span>◷ {item.start_date ? formatDate(item.start_date, item.timezone, { dateStyle: 'medium' }) : 'Date to be announced'}</span><span>⌖ {item.venue || 'Venue to be announced'}</span></div><a className="text-link" href={`/conferences/${item.id}`}>View conference <span aria-hidden="true">→</span></a></article>;
}

function HomePage() {
  const [data, retry] = useRetry('/api/conferences?limit=3');
  const [news, retryNews] = useRetry('/api/announcements');
  return <><section className="hero"><div className="hero-copy"><p className="eyebrow"><span className="live-dot"/> BANGLADESH UNIVERSITY OF PROFESSIONALS</p><h1>Ideas meet.<br/><em>Knowledge moves.</em></h1><p className="hero-lead">A place for research communities to gather, exchange perspectives and move meaningful work forward.</p><div className="hero-actions"><a className="button button-green" href="/conferences">Explore conferences <span aria-hidden="true">↗</span></a><a className="quiet-link" href="/submission-guidelines">How to submit <span aria-hidden="true">→</span></a></div><div className="hero-note"><span>RESEARCH</span><i/><span>COLLABORATION</span><i/><span>IMPACT</span></div></div><div className="hero-image"><img src="/hero.jpg" alt="Conference audience gathered for a presentation"/><div className="image-label"><span>CONVENING IDEAS. SHAPING WHAT'S NEXT.</span><span>BUP</span></div></div></section><section className="intro-strip"><p className="eyebrow">A BETTER WAY TO CONVENE</p><div><h2>From first abstract<br/>to final applause.</h2><p>Find conference details, deadlines and programme information published by the BUP conference team. As events are announced, their verified information will appear here.</p></div></section><section className="content-section"><div className="section-heading"><div><p className="eyebrow">WHAT'S ON</p><h2>Conferences</h2></div><a className="text-link" href="/conferences">Browse all <span aria-hidden="true">→</span></a></div><RequestState {...data} retry={retry}>{data.data?.length ? <div className="card-grid">{data.data.map((item) => <ConferenceCard key={item.id} item={item}/>)}</div> : <EmptyState title="No conferences published yet">There are no public conferences to display right now. Please check back for announcements or contact the conference team.</EmptyState>}</RequestState></section><section className="announcement-band"><div className="section-heading"><div><p className="eyebrow">LATEST UPDATES</p><h2>Announcements</h2></div></div><RequestState {...news} retry={retryNews}>{news.data?.length ? <div className="announcement-list">{news.data.map((item) => <article key={item.id}><time>{formatDate(item.published_at)}</time><div><h3>{item.title}</h3><p>{item.body}</p>{item.conference_id && <a className="text-link" href={`/conferences/${item.conference_id}`}>{item.conference_title} <span>→</span></a>}</div></article>)}</div> : <EmptyState title="No announcements yet">Conference news and deadline changes will appear here after the organizers publish them.</EmptyState>}</RequestState></section></>;
}

function ConferencesPage() {
  const [search, setSearch] = useState(''); const [status, setStatus] = useState(''); const [query, setQuery] = useState('');
  const path = useMemo(() => `/api/conferences?limit=60${query ? `&q=${encodeURIComponent(query)}` : ''}${status ? `&status=${encodeURIComponent(status)}` : ''}`, [query, status]);
  const [data, retry] = useRetry(path);
  return <><PageTitle title="Conferences" lead="Explore public conferences hosted by Bangladesh University of Professionals."/><section className="content-section narrow-section"><form className="filter-bar" onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()); }}><label className="search-field"><span className="sr-only">Search conferences</span><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by title or acronym"/></label><label className="filter-select">Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option value="published">Published</option><option value="submission_open">Submissions open</option><option value="in_review">In review</option><option value="completed">Completed</option></select></label><button className="button button-green" type="submit">Search</button></form><RequestState {...data} retry={retry}>{data.data?.length ? <div className="card-grid">{data.data.map((item) => <ConferenceCard key={item.id} item={item}/>)}</div> : <EmptyState title="No matching conferences">No public conferences match these filters. Clear the search or check back later.</EmptyState>}</RequestState></section></>;
}

function ConferenceDetail({ id }) {
  const [data, retry] = useRetry(`/api/conferences/${encodeURIComponent(id)}`);
  if (data.loading) return <section className="content-section"><Loading/></section>;
  if (data.error) return <section className="content-section"><ErrorState message={data.error} retry={retry}/></section>;
  const item = data.data;
  if (!item) return <section className="content-section"><EmptyState title="Conference not found"><a href="/conferences">Browse all published conferences</a> or contact the conference team.</EmptyState></section>;
  return <><PageTitle eyebrow={item.acronym || 'BUP CONFERENCE'} title={item.title} lead={item.description}/><section className="detail-layout"><div className="detail-main"><div className="detail-facts"><div><span>Conference dates</span><strong>{formatDate(item.start_date, item.timezone, { dateStyle: 'medium' })}{item.end_date ? ` – ${formatDate(item.end_date, item.timezone, { dateStyle: 'medium' })}` : ''}</strong></div><div><span>Submission deadline</span><strong>{formatDate(item.submission_deadline, item.timezone, { dateStyle: 'long' })}</strong></div><div><span>Venue</span><strong>{item.venue || 'To be announced'}</strong></div><div><span>Status</span><strong className="capitalize">{item.status.replaceAll('_', ' ')}</strong></div></div><h2>About this conference</h2><p>{item.description || 'More information will be published by the conference organizers.'}</p><h2>Explore this conference</h2><div className="link-grid">{[['Important dates','important-dates'],['Tracks','tracks'],['Schedule','schedule'],['Speakers','speakers'],['Committee','committee']].map(([label, path]) => <a key={path} href={`/${path}?conferenceId=${item.id}`}>{label}<span>→</span></a>)}</div></div><aside className="detail-aside"><p className="eyebrow">TAKE PART</p><h2>Be part of the conversation.</h2><p>Review the published submission and registration information for this event.</p><a className="button button-green button-full" href={`/submission-guidelines?conferenceId=${item.id}`}>Submission guidelines <span>→</span></a><a className="button button-outline button-full" href={`/registration-information?conferenceId=${item.id}`}>Registration information</a></aside></section></>;
}

function ConferencePicker({ value, onChange }) {
  const { loading, data, error } = useData('/api/conferences?limit=100');
  return <div className="conference-picker"><label htmlFor="conference-choice">Choose a conference</label>{loading ? <span className="muted">Loading conferences…</span> : error ? <span className="inline-error">{error}</span> : <select id="conference-choice" value={value} onChange={(event) => onChange(event.target.value)}><option value="">Select a published conference</option>{(data || []).map((conference) => <option value={conference.id} key={conference.id}>{conference.title}</option>)}</select>}</div>;
}
function ConferenceResourcePage({ title, description, resource, renderItem, emptyTitle }) {
  const params = new URLSearchParams(window.location.search); const [conferenceId, setConferenceId] = useState(params.get('conferenceId') || '');
  const path = conferenceId ? `/api/conferences/${encodeURIComponent(conferenceId)}/${resource}` : '';
  const [state, retry] = useRetry(path);
  return <><PageTitle title={title} lead={description}/><section className="content-section narrow-section"><ConferencePicker value={conferenceId} onChange={setConferenceId}/>{!conferenceId ? <EmptyState title="Choose a conference">Select a published conference above to view its {title.toLowerCase()}.</EmptyState> : <RequestState {...state} retry={retry}>{state.data?.length ? <div className="data-list">{state.data.map(renderItem)}</div> : <EmptyState title={emptyTitle || `No ${title.toLowerCase()} published`}>The organizers have not published this information for the selected conference yet.</EmptyState>}</RequestState>}</section></>;
}

function DatesPage() {
  return <ConferenceResourcePage title="Important dates" description="Keep up with published submission, registration and event milestones." resource="dates" emptyTitle="No dates published" renderItem={(item) => <article className="data-row" key={item.id}><div className="date-block"><span>{item.starts_at ? new Intl.DateTimeFormat('en', { day: '2-digit', timeZone: item.timezone || 'Asia/Dhaka' }).format(new Date(item.starts_at)) : '—'}</span><small>{item.starts_at ? new Intl.DateTimeFormat('en', { month: 'short', timeZone: item.timezone || 'Asia/Dhaka' }).format(new Date(item.starts_at)) : 'TBA'}</small></div><div><h2>{item.label}</h2><p>{item.description || 'See conference updates for details.'}</p>{item.starts_at && <span className="muted">{formatDate(item.starts_at, item.timezone)}{item.ends_at ? ` – ${formatDate(item.ends_at, item.timezone)}` : ''}</span>}</div></article>}/>;
}
function TracksPage() { return <ConferenceResourcePage title="Tracks" description="Explore the research themes and programme tracks announced for each conference." resource="tracks" renderItem={(item) => <article className="track-card" key={item.id}><span className="track-icon" aria-hidden="true">↗</span><h2>{item.name}</h2><p>{item.description || 'Track details will be provided by the organizers.'}</p>{item.topics?.length>0&&<ul>{item.topics.map(topic=><li key={topic.id}>{topic.name}{topic.description?` — ${topic.description}`:''}</li>)}</ul>}</article>}/>; }
function ScheduleView() {
  const { data } = useData('/api/auth/session');
  return <SchedulePage user={data?.user || null}/>;
}
function PeoplePage({ kind }) {
  const isSpeaker = kind === 'Speakers'; const endpoint = isSpeaker ? '/api/speakers' : '/api/committee';
  const [state, retry] = useRetry(endpoint);
  return <><PageTitle title={kind} lead={isSpeaker ? 'Meet speakers listed for public BUP conferences.' : 'The people and teams supporting BUP conferences.'}/><section className="content-section narrow-section"><RequestState {...state} retry={retry}>{state.data?.length ? <div className="people-grid">{state.data.map((person) => <article className="person-card" key={`${person.id}-${person.conference_id || person.role}`}><div className="person-avatar" aria-hidden="true">{person.full_name.split(/\s+/).slice(0,2).map((word) => word[0]).join('').toUpperCase()}</div><div><h2>{person.full_name}</h2><p>{person.institution || (person.role ? person.role.replaceAll('_',' ') : 'Conference speaker')}</p>{person.conference_title && <a className="text-link" href={`/conferences/${person.conference_id}`}>{person.conference_title} →</a>}</div></article>)}</div> : <EmptyState title={`No ${kind.toLowerCase()} listed`}>Profiles will appear after they are published by conference organizers.</EmptyState>}</RequestState></section></>;
}

const info = {
  '/about': { title: 'About BUP conferences', eyebrow: 'ABOUT US', lead: 'A platform for academic exchange, collaboration and professional learning.', sections: [['Our purpose', 'Bangladesh University of Professionals brings together researchers, practitioners and learners through conferences and academic events. This site is the public home for event information published by conference organizers.'], ['What you can find here', 'Browse announced conferences, published dates, tracks, schedules and participation guidance. Information appears here when organizers publish it.']] },
  '/submission-guidelines': { title: 'Submission guidelines', lead: 'Please follow the requirements published for the specific conference you plan to attend.', sections: [['Before submitting', 'Choose a conference and review its tracks, submission deadline and any linked requirements. Conference specific instructions take precedence.'], ['Prepare your submission', 'Check the conference page for accepted submission types, formatting, anonymization and file requirements. If these details have not been published, contact the organizing team before preparing your final submission.'], ['Submission portal', 'Online submission is not enabled in this public website foundation yet. Use the contact page to ask organizers about the submission process.']] },
  '/registration-information': { title: 'Registration information', lead: 'Registration arrangements are set by each conference organizing team.', sections: [['Fees and eligibility', 'Fees, discounts, payment methods and eligibility will be published on the relevant conference page when available. This site does not invent fees or registration deadlines.'], ['How to register', 'Online registration is not enabled in this public website foundation yet. Contact the organizing team for current registration instructions.']] },
  '/privacy-policy': { title: 'Privacy policy', eyebrow: 'POLICY INFORMATION', lead: 'This page is a project placeholder and must be reviewed by BUP before public launch.', sections: [['Information submitted', 'The contact form stores the name, email address, subject and message provided by a visitor in the conference database. Do not submit sensitive personal information through this starter form.'], ['Cookies and analytics', 'This foundation does not add analytics or advertising cookies. Hosting or infrastructure providers may keep operational logs.'], ['Questions', 'Contact the BUP conference team to ask about data access, retention or correction. A complete institutional privacy notice should replace this draft before launch.']] },
  '/terms': { title: 'Terms of use', eyebrow: 'POLICY INFORMATION', lead: 'This page is a project placeholder and must be reviewed by BUP before public launch.', sections: [['Using conference information', 'Conference dates, deadlines and programme details are displayed as published by organizers and may change. Check the linked conference source or contact the organizers when you need confirmation.'], ['Submissions and registration', 'This public site does not currently accept papers or registrations. A complete institutional terms notice should be approved and published before those features are enabled.']] },
};
function InfoPage({ page }) { const content = info[page]; return <><PageTitle eyebrow={content.eyebrow} title={content.title} lead={content.lead}/><section className="prose-section">{content.sections.map(([title, body]) => <article key={title}><h2>{title}</h2><p>{body}</p></article>)}<a className="text-link" href="/contact">Questions? Contact the team <span>→</span></a></section></>; }
function DynamicFAQPage() { const [state,retry]=useRetry('/api/faqs'); return <><PageTitle title="Frequently asked questions" lead="Answers published by the conference team."/><section className="faq-list"><RequestState {...state} retry={retry}>{state.data?.length?state.data.map(item=><details key={item.id}><summary>{item.question}<span aria-hidden="true">＋</span></summary><p>{item.answer}</p></details>):<EmptyState title="No FAQs published yet">Questions and answers will appear here after the conference team publishes them.</EmptyState>}</RequestState></section></>; }
function FAQPage() {
  const questions = [['Where can I find upcoming conferences?', 'Visit the Conferences page. It lists public events that organizers have published.'], ['How do I submit a paper?', 'Open the conference page and review its Submission guidelines. This foundation does not yet provide an online submission portal.'], ['How can I register?', 'Review the conference-specific Registration information. Online registration is not yet enabled on this website.'], ['Where are deadlines and schedules shown?', 'Choose a conference on Important dates or Schedule. Only information published by organizers appears there.'], ['How can I verify a certificate?', 'Use Certificate verification and enter the certificate number printed on the document. Verification works when the conference database is configured.'], ['Who should I contact for help?', 'Use the Contact form to send a message to the conference team.']];
  return <><PageTitle title="Frequently asked questions" lead="Quick answers about conference information and this website."/><section className="faq-list">{questions.map(([q,a]) => <details key={q}><summary>{q}<span aria-hidden="true">＋</span></summary><p>{a}</p></details>)}</section></>;
}
function ContactPage() {
  const [state, setState] = useState({ sending: false, error: '', success: '' });
  async function submit(event) { event.preventDefault(); const form = event.currentTarget; const body = Object.fromEntries(new FormData(form)); setState({ sending: true, error: '', success: '' }); try { const response = await request('/api/contact', { method: 'POST', body: JSON.stringify(body) }); setState({ sending: false, error: '', success: response.message || 'Your message has been received.' }); form.reset(); } catch (error) { setState({ sending: false, error: error.message, success: '' }); } }
  return <><PageTitle title="Contact" lead="Send a question to the BUP conference team."/><section className="form-layout"><div className="form-aside"><h2>We’re here to help.</h2><p>For conference-specific questions, include the event name so the team can direct your message.</p><p className="muted">Messages are sent to the conference database for follow-up.</p></div><form className="form-card" onSubmit={submit}><label>Your name<input name="name" autoComplete="name" required maxLength="160"/></label><label>Email address<input name="email" type="email" autoComplete="email" required maxLength="254"/></label><label>Subject<input name="subject" required maxLength="200"/></label><label>Message<textarea name="message" rows="5" required maxLength="5000"/></label>{state.error && <p className="form-message error" role="alert">{state.error}</p>}{state.success && <p className="form-message success" role="status">{state.success}</p>}<button className="button button-green" type="submit" disabled={state.sending}>{state.sending ? 'Sending…' : 'Send message'} <span aria-hidden="true">→</span></button></form></section></>;
}
function CertificatePage() {
  const params = new URLSearchParams(window.location.search);
  const initialNumber = params.get('number') || '';
  const [number, setNumber] = useState(initialNumber);
  const [query, setQuery] = useState(initialNumber);
  const [state, setState] = useState({ loading: false, data: null, error: '' });

  async function checkCertificate(num) {
    if (!num) return;
    setQuery(num.trim());
    setState({ loading: true, data: null, error: '' });
    try {
      const data = await request(`/api/certificates/verify/${encodeURIComponent(num.trim())}`);
      setState({ loading: false, data, error: '' });
    } catch (error) {
      setState({ loading: false, data: null, error: error.message });
    }
  }

  useEffect(() => {
    if (initialNumber) {
      checkCertificate(initialNumber);
    }
  }, []);

  async function submit(event) {
    event.preventDefault();
    checkCertificate(number);
  }

  return (
    <>
      <PageTitle
        title="Certificate verification"
        lead="Check whether a certificate number has been issued by a conference in this system and verify its current standing."
      />
      <section className="verify-wrap">
        <form className="verify-form" onSubmit={submit}>
          <label htmlFor="certificate-number">Certificate number</label>
          <div>
            <input
              id="certificate-number"
              value={number}
              onChange={(event) => setNumber(event.target.value)}
              required
              maxLength="100"
              autoComplete="off"
              placeholder="e.g. BUP-CERT-2026-BUP-CONF-ATT-1A2B3C"
            />
            <button className="button button-green" type="submit" disabled={state.loading}>
              Verify
            </button>
          </div>
        </form>

        {state.loading && <Loading label="Checking certificate in university records…" />}
        {state.error && <ErrorState message={state.error} />}

        {state.data && (
          <div
            className={`verification-result ${
              state.data.valid && !state.data.is_revoked ? 'valid' : 'invalid'
            }`}
            role="status"
          >
            <span className="result-icon" aria-hidden="true">
              {state.data.valid && !state.data.is_revoked ? '✓' : '!'}
            </span>
            <div>
              <h2>
                {!state.data.valid
                  ? 'No matching certificate'
                  : state.data.is_revoked
                  ? 'Certificate Revoked'
                  : 'Certificate Verified & Active'}
              </h2>

              {state.data.valid ? (
                <>
                  {state.data.is_revoked && (
                    <div
                      style={{
                        background: '#fee2e2',
                        borderLeft: '4px solid #ef4444',
                        padding: '10px 12px',
                        borderRadius: '4px',
                        color: '#991b1b',
                        marginBottom: '14px',
                        fontSize: '12px',
                      }}
                    >
                      <strong>This certificate was revoked by the conference authority.</strong>
                      <br />
                      <strong>Reason:</strong> {state.data.revocation_reason || 'Administrative action'}
                      <br />
                      <strong>Revoked on:</strong> {formatDate(state.data.revoked_at)}
                    </div>
                  )}

                  <dl>
                    <dt>Certificate Number</dt>
                    <dd>
                      <code>{state.data.certificate_number}</code>
                    </dd>
                    <dt>Recipient Name</dt>
                    <dd>{state.data.full_name}</dd>
                    <dt>Conference</dt>
                    <dd>{state.data.conference_title}</dd>
                    <dt>Certificate Type</dt>
                    <dd className="capitalize">{state.data.certificate_type}</dd>
                    <dt>Issued Date</dt>
                    <dd>{formatDate(state.data.issued_at)}</dd>
                    <dt>Status</dt>
                    <dd>
                      <strong style={{ color: state.data.is_revoked ? '#b91c1c' : '#15803d' }}>
                        {state.data.is_revoked ? 'Revoked (Invalid)' : 'Valid & Genuine'}
                      </strong>
                    </dd>
                  </dl>

                  {!state.data.is_revoked && state.data.download_url && (
                    <div style={{ marginTop: '16px' }}>
                      <a
                        href={`${API}${state.data.download_url}`}
                        target="_blank"
                        rel="noreferrer"
                        className="button button-green"
                        style={{ padding: '8px 16px', fontSize: '11px' }}
                      >
                        Download Verified Certificate PDF ⤓
                      </a>
                    </div>
                  )}
                </>
              ) : (
                <p>No active or historical certificate matches “{query}”. Verify the code format and try again.</p>
              )}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
function AuthPage({ type }) {
  const [state, setState] = useState({ sending: false, error: '', success: '' });
  const labels = { '/login': ['Welcome back', 'Sign in to your account'], '/register': ['Create your account', 'Create a Participant/Attendee account. Roles are assigned by authorized administrators.'], '/forgot-password': ['Reset your password', 'Enter the email address associated with your account'] };
  const [title, lead] = labels[type];
  async function submit(event) {
    event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form));
    const endpoint = type === '/login' ? '/api/auth/login' : type === '/register' ? '/api/auth/register' : '/api/auth/forgot-password';
    const body = type === '/register' ? { fullName: values.fullName, email: values.email, institution: values.institution, password: values.password } : type === '/login' ? { email: values.email, password: values.password } : { email: values.email };
    setState({ sending: true, error: '', success: '' });
    try {
      const result = await authMutation(endpoint, body);
      if (type === '/login' || result.authenticated) { window.location.href = '/dashboard'; return; }
      setState({ sending: false, error: '', success: result.message || 'Request completed.' });
      if (type === '/register') form.reset();
    } catch (error) { setState({ sending: false, error: error.message, success: '' }); }
  }
  return <><PageTitle title={title} lead={lead}/><section className="auth-wrap"><form className="form-card" onSubmit={submit}>
    {type === '/register' && <><label>Full name<input name="fullName" autoComplete="name" required minLength="2" maxLength="160"/></label><label>Institution <span className="muted">(optional)</span><input name="institution" autoComplete="organization" maxLength="200"/></label></>}
    <label>Email address<input name="email" type="email" autoComplete="email" required maxLength="254"/></label>
    {type !== '/forgot-password' && <label>Password<input name="password" type="password" autoComplete={type === '/login' ? 'current-password' : 'new-password'} minLength={type === '/register' ? 12 : 1} maxLength="128" required/>{type === '/register' && <small>Use at least 12 characters.</small>}</label>}
    {state.error && <p className="form-message error" role="alert">{state.error}</p>}{state.success && <p className="form-message success" role="status">{state.success}</p>}
    {type === '/login' && state.error.includes('Verify your email') && <button className="button button-outline button-full" type="button" onClick={async (event) => { const email = new FormData(event.currentTarget.form).get('email'); try { const result = await authMutation('/api/auth/resend-verification', { email }); setState({ sending: false, error: '', success: result.message }); } catch (error) { setState({ sending: false, error: error.message, success: '' }); } }}>Resend verification email</button>}
    <button className="button button-green button-full" type="submit" disabled={state.sending}>{state.sending ? 'Please wait…' : type === '/login' ? 'Sign in' : type === '/register' ? 'Create account' : 'Send reset link'}</button>
    <div className="auth-links">{type !== '/login' && <a href="/login">Sign in</a>}{type !== '/register' && <a href="/register">Create account</a>}{type !== '/forgot-password' && <a href="/forgot-password">Forgot password?</a>}</div>
  </form></section></>;
}

function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [state, setState] = useState({ sending: false, error: '', success: '' });
  async function submit(event) { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); if (values.password !== values.confirmPassword) { setState({ sending: false, error: 'Passwords do not match.', success: '' }); return; } setState({ sending: true, error: '', success: '' }); try { const result = await authMutation('/api/auth/reset-password', { token, password: values.password }); setState({ sending: false, error: '', success: result.message }); } catch (error) { setState({ sending: false, error: error.message, success: '' }); } }
  return <><PageTitle title="Choose a new password" lead="Reset links expire and can only be used once."/><section className="auth-wrap"><form className="form-card" onSubmit={submit}><label>New password<input name="password" type="password" autoComplete="new-password" minLength="12" maxLength="128" required/></label><label>Confirm password<input name="confirmPassword" type="password" autoComplete="new-password" minLength="12" maxLength="128" required/></label>{state.error && <p className="form-message error" role="alert">{state.error}</p>}{state.success && <p className="form-message success" role="status">{state.success} <a href="/login">Sign in</a></p>}<button className="button button-green button-full" disabled={state.sending || !token}>{state.sending ? 'Saving…' : 'Reset password'}</button>{!token && <p className="form-message error" role="alert">Reset token is missing. Request a new password reset link.</p>}</form></section></>;
}

function VerifyEmailPage() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [state, setState] = useState({ sending: false, error: '', success: '' });
  async function verify() { setState({ sending: true, error: '', success: '' }); try { const result = await authMutation('/api/auth/verify-email', { token }); setState({ sending: false, error: '', success: result.message }); } catch (error) { setState({ sending: false, error: error.message, success: '' }); } }
  return <><PageTitle title="Verify your email" lead="Confirm your email address to finish setting up your account."/><section className="auth-wrap"><div className="form-card">{state.error && <p className="form-message error" role="alert">{state.error}</p>}{state.success && <p className="form-message success" role="status">{state.success} <a href="/login">Sign in</a></p>}{!state.success && <button className="button button-green button-full" type="button" onClick={verify} disabled={!token || state.sending}>{state.sending ? 'Verifying…' : 'Verify email address'}</button>}{!token && <p className="form-message error" role="alert">Verification token is missing. Request a new verification email.</p>}</div></section></>;
}

function ProtectedPage({ children, role }) {
  const { loading, data, error } = useData('/api/auth/session');
  useEffect(() => { if (!loading && !error && !data?.user) window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`); }, [loading, error, data]);
  if (loading) return <section className="content-section"><Loading label="Checking your secure session…"/></section>;
  if (error) return <section className="content-section"><ErrorState message={error}/></section>;
  if (!data?.user) return <section className="content-section"><Loading label="Redirecting to sign in…"/></section>;
  if (role && !data.user.roles.includes('super_admin') && !data.user.roles.includes(role)) return <section className="content-section"><ErrorState message="Your account does not have access to this page."/></section>;
  return children(data.user);
}

function RegistrationView() {
  const { data } = useData('/api/auth/session');
  return <RegistrationPage user={data?.user || null}/>;
}

function DashboardPage() {
  const [state, retry] = useRetry('/api/auth/dashboard');
  return <ProtectedPage>{(user) => <><PageTitle title={`Welcome, ${user.fullName}`} lead="Your conference workspaces and account activity."/><section className="dashboard-content"><div className="dashboard-toolbar"><a className="button button-outline" href="/profile">Edit profile</a><a className="button button-outline" href="/schedule">Conference schedule</a><a className="button button-outline" href="/author/submissions">Author submissions</a><a className="button button-outline" href="/registrations">My registrations</a><a className="button button-outline" href="/certificates">My certificates</a>{user.roles.includes('reviewer')&&<a className="button button-outline" href="/reviewer">Reviewer workspace</a>}{user.roles.includes('session_chair')&&<a className="button button-outline" href="/chair">Chair workspace</a>}{(user.roles.includes('conference_admin')||user.roles.includes('super_admin'))&&<><a className="button button-outline" href="/admin/reviews">Peer review</a><a className="button button-outline" href="/admin/registrations">Registration & payments</a><a className="button button-outline" href="/admin/schedule">Schedule & attendance</a><a className="button button-outline" href="/admin/certificates">Certificates</a><a className="button button-outline" href="/admin/analytics">Analytics & reports</a></>}<a className="button button-outline" href="/change-password">Change password</a></div><RequestState {...state} retry={retry}>{state.data?.cards?.length ? <div className="dashboard-grid">{state.data.cards.map((card) => <article className="dashboard-card" key={card.role}><p className="eyebrow">{card.role.replaceAll('_',' ')}</p><h2>{card.title}</h2>{card.role === 'super_admin' && <p>{card.users} accounts · {card.conferences} conferences</p>}{card.conferences && Array.isArray(card.conferences) && <ul>{card.conferences.map((item) => <li key={item.id}><a href={`/conferences/${item.id}`}>{item.title}</a></li>)}</ul>}{card.submissions && <DataLinks rows={card.submissions} empty="No submissions yet." titleKey="title"/>}{card.reviews && <DataLinks rows={card.reviews} empty="No reviews assigned." titleKey="submission_title"/>}{card.registrations && <DataLinks rows={card.registrations} empty="No registrations yet." titleKey="title"/>}{card.sessions && <DataLinks rows={card.sessions} empty="No sessions assigned." titleKey="session_title"/>}<a className="text-link" href={card.role === 'attendee' ? '/registrations' : card.href}>Open workspace →</a></article>)}</div> : <EmptyState title="No role workspaces assigned">If you expected access, contact a Super Admin or the relevant conference organizer.</EmptyState>}</RequestState></section></> }</ProtectedPage>;
}
function DataLinks({ rows, empty, titleKey }) { return rows.length ? <ul>{rows.map((item) => <li key={item.id}>{item[titleKey]}{item.status ? ` · ${item.status.replaceAll('_',' ')}` : ''}</li>)}</ul> : <p className="muted">{empty}</p>; }

function ProfilePage() {
  const [message, setMessage] = useState({ error: '', success: '' }); const [saving, setSaving] = useState(false);
  return <ProtectedPage>{(user) => <><PageTitle title="Your profile" lead="Update the personal details shown to conference teams."/><section className="auth-wrap"><form className="form-card" onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form)); setSaving(true); setMessage({ error: '', success: '' }); try { const result = await authMutation('/api/auth/profile', values, 'PATCH'); setMessage({ error: '', success: 'Profile updated.' }); form.elements.fullName.value = result.user.fullName; } catch (error) { setMessage({ error: error.message, success: '' }); } finally { setSaving(false); } }}><label>Email address<input value={user.email} readOnly aria-describedby="email-help"/></label><small id="email-help">Email changes require a separate verification flow.</small><label>Full name<input name="fullName" defaultValue={user.fullName} autoComplete="name" minLength="2" maxLength="160" required/></label><label>Institution<input name="institution" defaultValue={user.institution} autoComplete="organization" maxLength="200"/></label><label>Job title<input name="jobTitle" defaultValue={user.jobTitle} maxLength="160"/></label><label>Phone<input name="phone" defaultValue={user.phone} autoComplete="tel" maxLength="40"/></label>{message.error && <p className="form-message error" role="alert">{message.error}</p>}{message.success && <p className="form-message success" role="status">{message.success}</p>}<button className="button button-green button-full" disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</button></form></section></>}</ProtectedPage>;
}

function ChangePasswordPage() {
  const [state, setState] = useState({ saving: false, error: '', success: '' });
  return <ProtectedPage>{() => <><PageTitle title="Change password" lead="Use a new password that you do not use elsewhere."/><section className="auth-wrap"><form className="form-card" onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form)); if (values.newPassword !== values.confirmPassword) { setState({ saving: false, error: 'New passwords do not match.', success: '' }); return; } setState({ saving: true, error: '', success: '' }); try { const result = await authMutation('/api/auth/change-password', { currentPassword: values.currentPassword, newPassword: values.newPassword }); setState({ saving: false, error: '', success: result.message }); form.reset(); } catch (error) { setState({ saving: false, error: error.message, success: '' }); } }}><label>Current password<input name="currentPassword" type="password" autoComplete="current-password" required/></label><label>New password<input name="newPassword" type="password" autoComplete="new-password" minLength="12" maxLength="128" required/></label><label>Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" minLength="12" maxLength="128" required/></label>{state.error && <p className="form-message error" role="alert">{state.error}</p>}{state.success && <p className="form-message success" role="status">{state.success}</p>}<button className="button button-green button-full" disabled={state.saving}>{state.saving ? 'Saving…' : 'Change password'}</button></form></section></>}</ProtectedPage>;
}

function AdminUsersPage() {
  const [state, retry] = useRetry('/api/auth/admin/users');
  return <ProtectedPage role="super_admin">{() => <><PageTitle title="Account administration" lead="User profiles and their assigned platform roles."/><section className="content-section narrow-section"><RequestState {...state} retry={retry}>{state.data?.length ? <div className="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Email verified</th><th>Status</th></tr></thead><tbody>{state.data.map((user) => <tr key={user.id}><td>{user.full_name}</td><td>{user.email}</td><td>{user.roles.map((role) => role.replaceAll('_',' ')).join(', ')}</td><td>{user.email_verified_at ? 'Yes' : 'No'}</td><td>{user.is_active ? 'Active' : 'Disabled'}</td></tr>)}</tbody></table></div> : <EmptyState title="No accounts found">No registered accounts are available yet.</EmptyState>}</RequestState></section></>}</ProtectedPage>;
}

function NotFound() { return <section className="not-found"><p className="eyebrow">404 · PAGE NOT FOUND</p><h1>This page isn’t here.</h1><p>Try one of the public conference pages.</p><a className="button button-green" href="/">Return home</a></section>; }

export default function App() {
  const pathname = decodeURIComponent(window.location.pathname).replace(/\/$/, '') || '/';
  const conferenceMatch = pathname.match(/^\/conferences\/([^/]+)$/);
  let page;
  if (pathname === '/') page = <HomePage/>;
  else if (pathname === '/conferences') page = <ConferencesPage/>;
  else if (conferenceMatch) page = <ConferenceDetail id={conferenceMatch[1]}/>;
  else if (pathname === '/important-dates') page = <DatesPage/>;
  else if (pathname === '/tracks') page = <TracksPage/>;
  else if (pathname === '/schedule') page = <ScheduleView/>;
  else if (pathname === '/admin/schedule') page = <ProtectedPage role="conference_admin">{()=><ScheduleAdmin/>}</ProtectedPage>;
  else if (pathname === '/chair') page = <ProtectedPage>{()=><ChairWorkspace/>}</ProtectedPage>;
  else if (pathname === '/check-in') page = <ProtectedPage>{(user)=><CheckInPage user={user}/>}</ProtectedPage>;
  else if (pathname === '/committee' || pathname === '/speakers') page = <PeoplePage kind={pathname === '/committee' ? 'Committee' : 'Speakers'}/>;
  else if (pathname === '/faq') page = <DynamicFAQPage/>;
  else if (pathname === '/contact') page = <ContactPage/>;
  else if (pathname === '/certificate-verification') page = <CertificatePage/>;
  else if (pathname === '/certificates') page = <ProtectedPage>{(user)=><CertificatesPage user={user}/>}</ProtectedPage>;
  else if (pathname === '/admin/certificates') page = <ProtectedPage role="conference_admin">{()=><CertificateAdmin/>}</ProtectedPage>;
  else if (pathname === '/admin/analytics') page = <ProtectedPage role="conference_admin">{()=><AnalyticsDashboard/>}</ProtectedPage>;
  else if (['/login','/register','/forgot-password'].includes(pathname)) page = <AuthPage type={pathname}/>;
  else if (pathname === '/reset-password') page = <ResetPasswordPage/>;
  else if (pathname === '/verify-email') page = <VerifyEmailPage/>;
  else if (pathname === '/dashboard') page = <DashboardPage/>;
  else if (pathname === '/author/submissions' || pathname === '/submissions/new') page = <ProtectedPage>{(user)=><AuthorSubmissions user={user}/>}</ProtectedPage>;
  else if (pathname === '/reviewer') page = <ProtectedPage role="reviewer">{()=><ReviewerWorkspace/>}</ProtectedPage>;
  else if (pathname === '/admin/reviews') page = <ProtectedPage role="conference_admin">{()=><ReviewAdmin/>}</ProtectedPage>;
  else if (pathname === '/admin/registrations') page = <ProtectedPage role="conference_admin">{()=><RegistrationAdmin/>}</ProtectedPage>;
  else if (pathname === '/admin' || pathname === '/organizer') page = <AdminWorkspace/>;
  else if (pathname === '/registration-information' || pathname === '/registrations') page = <RegistrationView/>;
  else if (pathname === '/profile') page = <ProfilePage/>;
  else if (pathname === '/change-password') page = <ChangePasswordPage/>;
  else if (pathname === '/admin/users') page = <AdminUsersPage/>;
  else if (info[pathname]) page = <InfoPage page={pathname}/>;
  else page = <NotFound/>;
  return <div className="app-shell"><a className="skip-link" href="#main-content">Skip to content</a><Header/><main id="main-content" className={pathname === '/' ? 'home-main' : 'inner-main'}>{page}</main><Footer/></div>;
}

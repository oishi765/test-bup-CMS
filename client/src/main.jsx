import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './admin.css';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('BUP App ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '40px 20px', maxWidth: '720px', margin: '50px auto', fontFamily: 'system-ui, sans-serif' }}>
          <div style={{ background: '#fef2f2', border: '1px solid #f87171', borderRadius: '8px', padding: '24px' }}>
            <h2 style={{ color: '#991b1b', margin: '0 0 12px', fontSize: '20px' }}>Application Error</h2>
            <p style={{ color: '#4b5563', fontSize: '14px', margin: '0 0 16px' }}>
              An error occurred while rendering the page:
            </p>
            <pre style={{ background: '#ffffff', border: '1px solid #fca5a5', padding: '14px', borderRadius: '4px', fontSize: '12px', overflowX: 'auto', color: '#b91c1c' }}>
              {this.state.error?.stack || this.state.error?.message || String(this.state.error)}
            </pre>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                marginTop: '16px',
                padding: '10px 18px',
                background: '#28734c',
                color: '#ffffff',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '13px',
              }}
            >
              Reload Page ⟳
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}

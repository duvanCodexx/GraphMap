import React from 'react'
import EmbedingDashboard from './EmbedingDashboard.jsx'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('[React ErrorBoundary]', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: '100vh',
            backgroundColor: '#0d1515',
            color: '#e1fdff',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            padding: 24,
            textAlign: 'center',
          }}
        >
          <div
            style={{
              background: '#151d1e',
              border: '1px solid rgba(255, 180, 171, 0.3)',
              borderRadius: '12px',
              padding: '24px',
              maxWidth: '850px',
              width: '100%',
              boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
            }}
          >
            <h2 style={{ fontSize: '18px', fontWeight: 'bold', marginBottom: '8px', color: '#ffb4ab' }}>
              Error en la interfaz de GraphMap
            </h2>
            <p style={{ fontSize: '13px', color: '#849495', marginBottom: '16px' }}>
              Se ha capturado una excepción en tiempo de ejecución. Puedes pulsar F12 para abrir DevTools o reiniciar.
            </p>
            <pre
              style={{
                background: '#080f10',
                padding: '12px',
                borderRadius: '8px',
                overflowX: 'auto',
                fontSize: '11px',
                color: '#ffdad6',
                textAlign: 'left',
                maxHeight: '250px',
                marginBottom: '20px',
              }}
            >
              {String(this.state.error?.stack || this.state.error?.message || this.state.error)}
            </pre>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '10px 24px',
                backgroundColor: '#00f2ff',
                color: '#00363a',
                border: 'none',
                borderRadius: '8px',
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: '13px',
              }}
            >
              Recargar Aplicación
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <EmbedingDashboard />
    </ErrorBoundary>
  )
}


import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import './index.css'
import App from './App.jsx'
import PartialBlockDebug from './debug/PartialBlockDebug.jsx'

// Initialize performance profiler (exposes window.__profiler)
import './utils/PerformanceProfiler.js'

// Simple hash-based routing for debug pages
function Router() {
  const [route, setRoute] = useState(window.location.hash);

  useEffect(() => {
    const handleHashChange = () => setRoute(window.location.hash);
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // Route to debug page if hash matches
  if (route === '#debug' || route === '#debug/partial-blocks') {
    return <PartialBlockDebug />;
  }

  // Default: main app
  return <App />;
}

createRoot(document.getElementById('root')).render(<Router />)

import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(<App />)

// Register the PWA service worker in production builds only (the dev server
// has no /portal/sw.js to serve). Scope is /portal/ (Vite base); it never
// caches anything — see apps/web/public/sw.js.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => {
      /* service worker is best-effort; the portal works without it */
    })
  })
}

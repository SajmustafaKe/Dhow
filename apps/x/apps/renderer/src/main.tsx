import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ThemeProvider } from '@/contexts/theme-context'
import { VideoPopout } from '@/components/video-popout'
import { MeetingDetectedPopup } from '@/components/meeting-detected-popup'
import { QuickAskBar } from '@/components/quick-ask-bar'

const root = createRoot(document.getElementById('root')!)

// The popout windows load the same bundle with a hash route and render only
// their own mini UI — no main app shell.
if (window.location.hash === '#video-popout') {
  root.render(
    <StrictMode>
      <VideoPopout />
    </StrictMode>,
  )
} else if (window.location.hash === '#meeting-detected') {
  // "Meeting detected — Take Notes?" popup window; same pattern.
  root.render(
    <StrictMode>
      <MeetingDetectedPopup />
    </StrictMode>,
  )
} else if (window.location.hash === '#quick-ask') {
  // Global ⌥⇧Space quick-ask bar; same pattern.
  root.render(
    <StrictMode>
      <QuickAskBar />
    </StrictMode>,
  )
} else {
  root.render(
    <StrictMode>
      <ThemeProvider defaultTheme="system">
        <App />
      </ThemeProvider>
    </StrictMode>,
  )
}

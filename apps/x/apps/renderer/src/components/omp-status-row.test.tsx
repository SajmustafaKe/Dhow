import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { OmpStatusRow } from './settings-dialog'
import type { OmpAgentStatus } from '@/lib/code-mode-provisioning'

afterEach(cleanup)

const row = (omp: OmpAgentStatus | null) =>
  render(<OmpStatusRow status={omp} onRecheck={() => {}} />)

describe('OmpStatusRow', () => {
  it('offers install instructions when the binary is absent', () => {
    row({ installed: false, signedIn: false, authenticated: false })
    expect(screen.getByText('Not installed')).toBeTruthy()
    // Install guidance, not an "Enable" affordance — Dhow cannot fetch omp.
    expect(screen.getByText(/npm i -g @oh-my-pi\/pi-coding-agent/)).toBeTruthy()
    expect(screen.queryByText('Ready')).toBeNull()
  })

  // The invariant worth defending: an unfinished probe is not a failure.
  // `!authenticated` would collapse null into false and slander a working install.
  it('reports an unfinished auth probe as checking, not as failure', () => {
    row({ installed: true, signedIn: true, authenticated: null })
    expect(screen.getByText('Installed')).toBeTruthy()
    expect(screen.getByText('Checking…')).toBeTruthy()
    expect(screen.queryByText('Authenticated')).toBeNull()
    // Nothing is claimed ready, and no remediation is suggested yet.
    expect(screen.queryByText('Ready')).toBeNull()
    expect(screen.queryByText(/couldn't open a session/)).toBeNull()
  })

  it('claims Ready only once a session has actually opened', () => {
    row({ installed: true, signedIn: true, authenticated: true })
    expect(screen.getByText('Authenticated')).toBeTruthy()
    expect(screen.getByText('Ready')).toBeTruthy()
    expect(screen.queryByText('Checking…')).toBeNull()
  })

  it('points a credential-less install at its provider config', () => {
    row({ installed: true, signedIn: true, authenticated: false })
    expect(screen.getByText('Authenticated')).toBeTruthy()
    expect(screen.getByText(/couldn't open a session/)).toBeTruthy()
    expect(screen.getByText(/~\/\.omp\/agent\/config\.yml/)).toBeTruthy()
    // Installed but unusable must never read as Ready.
    expect(screen.queryByText('Ready')).toBeNull()
  })
})

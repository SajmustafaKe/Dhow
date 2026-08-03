"use client"

import { useState } from "react"
import { Check, Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { MailSecurity } from "@x/shared/dist/mail.js"

/**
 * Connect a mailbox over IMAP + SMTP.
 *
 * Unlike Google and Microsoft there is no browser redirect to lean on — the
 * credential is a host/port/username/password tuple, so this is a form.
 *
 * Incoming and outgoing are configured and tested separately because they fail
 * independently: a working IMAP login says nothing about whether SMTP accepts
 * the same credentials, and most hosts use a different port and security mode
 * for each. Reporting one combined result would hide the half that is broken.
 */

interface Preset {
  label: string
  host: string
  port: number
  security: MailSecurity
  smtpHost: string
  smtpPort: number
  smtpSecurity: MailSecurity
  hint?: string
}

const PRESETS: Preset[] = [
  { label: "Yahoo Mail", host: "imap.mail.yahoo.com", port: 993, security: "ssl", smtpHost: "smtp.mail.yahoo.com", smtpPort: 465, smtpSecurity: "ssl", hint: "Requires an app password" },
  { label: "Fastmail", host: "imap.fastmail.com", port: 993, security: "ssl", smtpHost: "smtp.fastmail.com", smtpPort: 465, smtpSecurity: "ssl", hint: "Requires an app password" },
  { label: "iCloud Mail", host: "imap.mail.me.com", port: 993, security: "ssl", smtpHost: "smtp.mail.me.com", smtpPort: 587, smtpSecurity: "starttls", hint: "Requires an app-specific password" },
  { label: "Zoho Mail", host: "imap.zoho.com", port: 993, security: "ssl", smtpHost: "smtp.zoho.com", smtpPort: 465, smtpSecurity: "ssl" },
  { label: "GMX / Mail.com", host: "imap.gmx.com", port: 993, security: "ssl", smtpHost: "mail.gmx.com", smtpPort: 587, smtpSecurity: "starttls" },
  { label: "Proton (Bridge)", host: "127.0.0.1", port: 1143, security: "starttls", smtpHost: "127.0.0.1", smtpPort: 1025, smtpSecurity: "starttls", hint: "Proton Bridge must be running locally" },
  { label: "cPanel / self-hosted", host: "", port: 993, security: "ssl", smtpHost: "", smtpPort: 587, smtpSecurity: "starttls", hint: "Usually mail.yourdomain.com for both" },
]

const SECURITY_OPTIONS: { value: MailSecurity; label: string }[] = [
  { value: "ssl", label: "SSL/TLS" },
  { value: "starttls", label: "STARTTLS" },
  { value: "none", label: "None" },
]

export interface ImapAccountFormProps {
  onSave: (input: {
    host: string
    port: number
    security: MailSecurity
    smtpHost: string | null
    smtpPort: number | null
    smtpSecurity: MailSecurity
    username: string
    password: string
    email: string | null
  }) => Promise<{ ok: boolean; error?: string }>
  onCancel: () => void
  /** Warn when the OS keychain is unavailable, so the password lands in plaintext. */
  encryptionAvailable: boolean
}

type TestState = {
  incoming: { ok: boolean; error?: string }
  outgoing: { ok: boolean; error?: string } | null
} | null

function SecuritySelect({ value, onChange }: { value: MailSecurity; onChange: (v: MailSecurity) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as MailSecurity)}
      className="h-9 rounded-md border bg-background px-2 text-sm"
    >
      {SECURITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

export function ImapAccountForm({ onSave, onCancel, encryptionAvailable }: ImapAccountFormProps) {
  const [preset, setPreset] = useState(PRESETS[0].label)
  const [host, setHost] = useState(PRESETS[0].host)
  const [port, setPort] = useState(String(PRESETS[0].port))
  const [security, setSecurity] = useState<MailSecurity>(PRESETS[0].security)
  const [smtpHost, setSmtpHost] = useState(PRESETS[0].smtpHost)
  const [smtpPort, setSmtpPort] = useState(String(PRESETS[0].smtpPort))
  const [smtpSecurity, setSmtpSecurity] = useState<MailSecurity>(PRESETS[0].smtpSecurity)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState<"test" | "save" | null>(null)
  const [tested, setTested] = useState<TestState>(null)
  const [error, setError] = useState<string | null>(null)

  const applyPreset = (label: string) => {
    const found = PRESETS.find((p) => p.label === label)
    setPreset(label)
    setTested(null)
    if (!found) return
    setHost(found.host)
    setPort(String(found.port))
    setSecurity(found.security)
    setSmtpHost(found.smtpHost)
    setSmtpPort(String(found.smtpPort))
    setSmtpSecurity(found.smtpSecurity)
  }

  const hint = PRESETS.find((p) => p.label === preset)?.hint
  const filled = host.trim() && username.trim() && password

  const test = async () => {
    setBusy("test")
    setError(null)
    try {
      const res = await window.ipc.invoke("imap:test", {
        host: host.trim(),
        port: Number(port) || 993,
        security,
        smtpHost: smtpHost.trim() || undefined,
        smtpPort: Number(smtpPort) || undefined,
        smtpSecurity,
        username: username.trim(),
        password,
      })
      setTested(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setBusy(null)
  }

  const submit = async () => {
    setBusy("save")
    setError(null)
    const res = await onSave({
      host: host.trim(),
      port: Number(port) || 993,
      security,
      smtpHost: smtpHost.trim() || null,
      smtpPort: smtpHost.trim() ? Number(smtpPort) || 587 : null,
      smtpSecurity,
      username: username.trim(),
      password,
      email: username.trim() || null,
    })
    if (!res.ok) setError(res.error ?? "Could not connect.")
    setBusy(null)
  }

  const result = (label: string, state: { ok: boolean; error?: string } | null | undefined) => {
    if (!state) return null
    return (
      <div className={`flex items-start gap-1.5 text-xs ${state.ok ? "text-emerald-600" : "text-amber-600"}`}>
        {state.ok ? <Check className="size-3.5 shrink-0 mt-0.5" /> : <X className="size-3.5 shrink-0 mt-0.5" />}
        <span>{label}: {state.ok ? "connected" : state.error ?? "failed"}</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 rounded-md border p-3">
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground">Provider</label>
        <select
          value={preset}
          onChange={(e) => applyPreset(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          {PRESETS.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
        </select>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Incoming (IMAP)</span>
        <div className="grid grid-cols-[1fr_90px_120px] gap-2">
          <Input value={host} onChange={(e) => { setHost(e.target.value); setTested(null) }} placeholder="imap.example.com" />
          <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" placeholder="993" />
          <SecuritySelect value={security} onChange={(v) => { setSecurity(v); setTested(null) }} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Outgoing (SMTP)</span>
        <div className="grid grid-cols-[1fr_90px_120px] gap-2">
          <Input value={smtpHost} onChange={(e) => { setSmtpHost(e.target.value); setTested(null) }} placeholder="smtp.example.com" />
          <Input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} inputMode="numeric" placeholder="587" />
          <SecuritySelect value={smtpSecurity} onChange={(v) => { setSmtpSecurity(v); setTested(null) }} />
        </div>
        {/* Receiving still works without it, so this is optional rather than required. */}
        <span className="text-xs text-muted-foreground">Leave blank to receive only — replies need an outgoing server.</span>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Sign in</span>
        <Input
          value={username}
          onChange={(e) => { setUsername(e.target.value); setTested(null) }}
          placeholder="you@example.com"
          autoComplete="off"
        />
        <Input
          type="password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setTested(null) }}
          placeholder="App password"
          autoComplete="off"
        />
        <span className="text-xs text-muted-foreground">
          Most providers require an app password rather than your account password.
        </span>
      </div>

      {tested && (
        <div className="flex flex-col gap-1 rounded-md border bg-muted/40 p-2">
          {result("Incoming", tested.incoming)}
          {tested.outgoing
            ? result("Outgoing", tested.outgoing)
            : <span className="text-xs text-muted-foreground">Outgoing: not configured</span>}
        </div>
      )}

      {!encryptionAvailable && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700">
          This machine has no available keychain, so the password will be stored unencrypted in
          <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono">~/.dhow/config/imap.json</code>.
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={!filled || busy !== null} onClick={() => void test()}>
          {busy === "test" ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Test connection
        </Button>
        <Button size="sm" disabled={!filled || busy !== null} onClick={() => void submit()}>
          {busy === "save" ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {busy === "save" ? "Connecting…" : "Connect"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy !== null}>Cancel</Button>
      </div>
    </div>
  )
}

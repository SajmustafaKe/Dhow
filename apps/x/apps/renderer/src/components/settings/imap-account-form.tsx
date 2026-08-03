"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/**
 * Connect a mailbox over IMAP.
 *
 * Unlike Google and Microsoft there is no browser redirect to lean on — IMAP's
 * credential is a host/port/username/password tuple, so this is a form. The
 * connection is tested before anything is saved, because a typo that only
 * surfaces as "no mail ever arrives" is far worse than a failed submit.
 */

/** Common providers, so most people never type a hostname. */
const PRESETS: { label: string; host: string; port: number; secure: boolean; hint?: string }[] = [
  { label: "Yahoo Mail", host: "imap.mail.yahoo.com", port: 993, secure: true, hint: "Requires an app password" },
  { label: "Fastmail", host: "imap.fastmail.com", port: 993, secure: true, hint: "Requires an app password" },
  { label: "iCloud Mail", host: "imap.mail.me.com", port: 993, secure: true, hint: "Requires an app-specific password" },
  { label: "Zoho Mail", host: "imap.zoho.com", port: 993, secure: true },
  { label: "Proton (Bridge)", host: "127.0.0.1", port: 1143, secure: false, hint: "Proton Bridge must be running locally" },
  { label: "Other / self-hosted", host: "", port: 993, secure: true },
]

export interface ImapAccountFormProps {
  onSave: (input: {
    host: string
    port: number
    secure: boolean
    username: string
    password: string
    email: string | null
  }) => Promise<{ ok: boolean; error?: string }>
  onCancel: () => void
  /** Warn when the OS keychain is unavailable, so the password lands in plaintext. */
  encryptionAvailable: boolean
}

export function ImapAccountForm({ onSave, onCancel, encryptionAvailable }: ImapAccountFormProps) {
  const [preset, setPreset] = useState(PRESETS[0].label)
  const [host, setHost] = useState(PRESETS[0].host)
  const [port, setPort] = useState(String(PRESETS[0].port))
  const [secure, setSecure] = useState(PRESETS[0].secure)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const applyPreset = (label: string) => {
    const found = PRESETS.find((p) => p.label === label)
    setPreset(label)
    if (!found) return
    setHost(found.host)
    setPort(String(found.port))
    setSecure(found.secure)
  }

  const hint = PRESETS.find((p) => p.label === preset)?.hint

  const submit = async () => {
    setBusy(true)
    setError(null)
    const res = await onSave({
      host: host.trim(),
      port: Number(port) || 993,
      secure,
      username: username.trim(),
      password,
      email: username.trim() || null,
    })
    if (!res.ok) setError(res.error ?? "Could not connect.")
    setBusy(false)
  }

  const ready = host.trim() && username.trim() && password && !busy

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
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

      <div className="grid grid-cols-[1fr_100px] gap-2">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">IMAP server</label>
          <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="imap.example.com" />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">Port</label>
          <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />
        Use TLS
      </label>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground">Email or username</label>
        <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="you@example.com" autoComplete="off" />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground">Password</label>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="App password"
          autoComplete="off"
        />
        <span className="text-xs text-muted-foreground">
          Most providers require an app password rather than your account password.
        </span>
      </div>

      {!encryptionAvailable && (
        // Say it plainly: on a machine with no keychain this is stored as text.
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
        <Button size="sm" disabled={!ready} onClick={() => void submit()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {busy ? "Testing connection…" : "Connect"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  )
}

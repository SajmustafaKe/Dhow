"use client"

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const GOOGLE_CLIENT_ID_SETUP_GUIDE_URL =
  "https://github.com/SajmustafaKe/Dhow/blob/main/google-setup.md"

/**
 * BYOK credentials are per provider, so the copy is too. Both providers use
 * the same loopback redirect and the same OIDC flow — only the console the
 * user visits and the shape of the ids differ.
 */
export type ClientIdProvider = "google" | "microsoft"

const PROVIDER_COPY: Record<ClientIdProvider, {
  title: string
  blurb: string
  clientIdLabel: string
  clientIdPlaceholder: string
  secretLabel: string
  secretPlaceholder: string
  /** Microsoft desktop registrations are usually public clients. */
  secretOptional: boolean
  guideUrl: string
  guideLabel: string
  redirectNote: string
}> = {
  google: {
    title: "Google OAuth Credentials",
    blurb: "Enter the credentials for your Google OAuth app to connect.",
    clientIdLabel: "Client ID",
    clientIdPlaceholder: "xxxxxxxxxxxx-xxxx.apps.googleusercontent.com",
    secretLabel: "Client Secret",
    secretPlaceholder: "GOCSPX-...",
    secretOptional: false,
    guideUrl: GOOGLE_CLIENT_ID_SETUP_GUIDE_URL,
    guideLabel: "Google setup guide",
    redirectNote: "http://localhost:8080/oauth/callback",
  },
  microsoft: {
    title: "Microsoft OAuth Credentials",
    blurb:
      "Register a desktop app in Azure and paste its Application (client) ID. " +
      "Choose \"any organizational directory and personal Microsoft accounts\" so Outlook.com and Microsoft 365 both work.",
    clientIdLabel: "Application (client) ID",
    clientIdPlaceholder: "00000000-0000-0000-0000-000000000000",
    secretLabel: "Client Secret",
    // A desktop registration is a public client; most tenants need no secret.
    secretPlaceholder: "Only if your tenant requires one",
    secretOptional: true,
    guideUrl: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    guideLabel: "Azure app registrations",
    redirectNote: "http://localhost:8080/oauth/callback",
  },
}

interface GoogleClientIdModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (clientId: string, clientSecret: string) => void
  isSubmitting?: boolean
  description?: string
  /** Defaults to google so existing call sites are unchanged. */
  provider?: ClientIdProvider
}

export function GoogleClientIdModal({
  open,
  onOpenChange,
  onSubmit,
  isSubmitting = false,
  description,
  provider = "google",
}: GoogleClientIdModalProps) {
  const copy = PROVIDER_COPY[provider]
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")

  useEffect(() => {
    if (!open) {
      setClientId("")
      setClientSecret("")
    }
  }, [open])

  const trimmedClientId = clientId.trim()
  const trimmedClientSecret = clientSecret.trim()
  const isValid = trimmedClientId.length > 0 && (copy.secretOptional || trimmedClientSecret.length > 0)

  const handleSubmit = () => {
    if (!isValid || isSubmitting) return
    onSubmit(trimmedClientId, trimmedClientSecret)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(28rem,calc(100%-2rem))] max-w-md p-0 gap-0 overflow-hidden rounded-xl">
        <div className="p-6 pb-0">
          <DialogHeader className="space-y-1.5">
            <DialogTitle className="text-lg font-semibold">{copy.title}</DialogTitle>
            <DialogDescription className="text-sm">
              {description ?? copy.blurb}
            </DialogDescription>
          </DialogHeader>
        </div>
        <div className="px-6 py-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block" htmlFor="google-client-id">
              {copy.clientIdLabel}
            </label>
            <Input
              id="google-client-id"
              placeholder={copy.clientIdPlaceholder}
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  handleSubmit()
                }
              }}
              className="font-mono text-xs"
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block" htmlFor="google-client-secret">
              {copy.secretLabel}{copy.secretOptional ? " (optional)" : ""}
            </label>
            <Input
              id="google-client-secret"
              type="password"
              placeholder={copy.secretPlaceholder}
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  handleSubmit()
                }
              }}
              className="font-mono text-xs"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Need help?{" "}
            <a
              className="text-primary underline underline-offset-4 hover:text-primary/80"
              href={copy.guideUrl}
              target="_blank"
              rel="noreferrer"
            >
              Read the setup guide
            </a>
          </p>
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t bg-muted/30">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!isValid || isSubmitting}>
            Continue
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

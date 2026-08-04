import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileText, Loader2 } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner';

type GoogleDocPickerDialogProps = {
  open: boolean
  targetFolder: string
  onOpenChange: (open: boolean) => void
  onImported: (path: string) => void
}

/**
 * Accepts a Google Docs URL in any of the shapes Google hands out, or a bare
 * file id pasted on its own. Returns null when nothing id-shaped is present.
 */
export function extractGoogleDocId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const fromPath = trimmed.match(/\/d\/([A-Za-z0-9_-]{10,})/)
  if (fromPath) return fromPath[1]
  const fromQuery = trimmed.match(/[?&]id=([A-Za-z0-9_-]{10,})/)
  if (fromQuery) return fromQuery[1]
  // A bare id: no scheme, no slashes, long enough to be real.
  if (/^[A-Za-z0-9_-]{10,}$/.test(trimmed)) return trimmed
  return null
}

/**
 * Import a Google Doc into the workspace by link. Uses the user's own Google
 * OAuth client (see google-setup.md) — the same connection Gmail and Calendar
 * use — so the prerequisite is a connected Google account holding the
 * drive.file scope.
 */
export function GoogleDocPickerDialog({
  open,
  targetFolder,
  onOpenChange,
  onImported,
}: GoogleDocPickerDialogProps) {
  const [status, setStatus] = useState<{ connected: boolean; hasRequiredScopes: boolean } | null>(null)
  const [link, setLink] = useState('')
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const targetLabel = useMemo(() => targetFolder.replace(/^knowledge\/?/, '') || 'knowledge', [targetFolder])
  const fileId = useMemo(() => extractGoogleDocId(link), [link])

  const loadStatus = useCallback(async () => {
    try {
      const result = await window.ipc.invoke('google-docs:getStatus', null)
      setStatus({ connected: result.connected, hasRequiredScopes: result.hasRequiredScopes })
      setError(null)
    } catch (err) {
      setStatus(null)
      setError(err instanceof Error ? err.message : 'Failed to check your Google connection')
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setLink('')
    setError(null)
    void loadStatus()
  }, [loadStatus, open])

  const handleImport = useCallback(async () => {
    if (!fileId) return
    setError(null)
    setImporting(true)
    try {
      const result = await window.ipc.invoke('google-docs:import', { fileId, targetFolder })
      onOpenChange(false)
      onImported(result.path)
      toast.success(`Imported "${result.doc.name}"`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import that document')
    } finally {
      setImporting(false)
    }
  }, [fileId, targetFolder, onImported, onOpenChange])

  const ready = status !== null && status.connected && status.hasRequiredScopes

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Google Doc</DialogTitle>
          <DialogDescription>
            Paste a Google Docs link to import it into <span className="font-medium">{targetLabel}</span>. The
            imported note stays linked to the original and can be synced both ways.
          </DialogDescription>
        </DialogHeader>

        {status !== null && !ready ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {status.connected
                ? 'Your Google connection is missing the Drive access needed to import documents. Reconnect Google from Settings \u2192 Connect Accounts to grant it.'
                : 'Connect your Google account from Settings \u2192 Connect Accounts to import documents.'}
            </p>
            <div className="flex justify-end">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <Input
              autoFocus
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && fileId && !importing) void handleImport()
              }}
              placeholder="https://docs.google.com/document/d/..."
            />
            {link.trim() !== '' && !fileId && (
              <p className="text-xs text-muted-foreground">
                That doesn&apos;t look like a Google Docs link. Copy the URL from your browser&apos;s address bar.
              </p>
            )}
            {error && <p className="text-xs text-red-500">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={importing}>
                Cancel
              </Button>
              <Button onClick={() => void handleImport()} disabled={!fileId || importing}>
                {importing
                  ? <Loader2 className="mr-2 size-4 animate-spin" />
                  : <FileText className="mr-2 size-4" />}
                {importing ? 'Importing...' : 'Import'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

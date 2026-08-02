"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2, Users, ListTodo, AlertTriangle, Plus, Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { Assignment, CouncilMember, CouncilSession } from "@x/shared/dist/council.js"

/**
 * Council — put one question to a standing group of advisors.
 *
 * Two things this view must never do, because they defeat the point:
 * - Hide a member that failed to answer. A missing voice reads as agreement.
 * - Bury the disagreements section. It is the reason to convene at all.
 */

type Tab = "ask" | "assignments" | "members"

const STATUS_LABELS: Record<Assignment["status"], string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
}

const STATUS_STYLES: Record<Assignment["status"], string> = {
  open: "text-muted-foreground",
  in_progress: "text-blue-600",
  blocked: "text-amber-600",
  done: "text-emerald-600",
  cancelled: "text-muted-foreground line-through",
}

export function CouncilView() {
  const [tab, setTab] = useState<Tab>("ask")
  const [members, setMembers] = useState<CouncilMember[]>([])
  const [sessions, setSessions] = useState<CouncilSession[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])

  const [question, setQuestion] = useState("")
  const [convening, setConvening] = useState(false)
  const [active, setActive] = useState<CouncilSession | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    const [m, s, a] = await Promise.all([
      window.ipc.invoke("council:listMembers", null),
      window.ipc.invoke("council:listSessions", null),
      window.ipc.invoke("council:listAssignments", null),
    ])
    setMembers(m.members)
    setSessions(s.sessions)
    setAssignments(a.assignments)
  }, [])

  useEffect(() => { void loadAll() }, [loadAll])

  const memberTitle = useCallback(
    (id: string) => members.find((m) => m.id === id)?.title ?? id,
    [members],
  )

  const ask = useCallback(async () => {
    const q = question.trim()
    if (!q || convening) return
    setConvening(true)
    setError(null)
    try {
      const res = await window.ipc.invoke("council:convene", { question: q })
      if (res.error || !res.session) {
        setError(res.error ?? "The council returned nothing.")
      } else {
        setActive(res.session)
        setQuestion("")
        await loadAll()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setConvening(false)
    }
  }, [question, convening, loadAll])

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="px-6 pt-5 pb-3 shrink-0">
        <h2 className="text-[24px] font-[650] tracking-[-0.02em] text-[#0d0e11] dark:text-[#f4f5f7]">Council</h2>
        <p className="text-sm text-muted-foreground mt-1">
          One question, answered independently by each member, then a memo that names the disagreements.
        </p>
        <div className="flex items-center gap-1 mt-4">
          {([
            ["ask", "Ask", Users],
            ["assignments", "Assignments", ListTodo],
            ["members", "Members", Users],
          ] as const).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
                tab === id ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-8">
        {tab === "ask" && (
          <AskTab
            question={question}
            setQuestion={setQuestion}
            convening={convening}
            onAsk={ask}
            error={error}
            active={active}
            sessions={sessions}
            onSelect={setActive}
            memberTitle={memberTitle}
            memberCount={members.filter((m) => m.enabled).length}
          />
        )}
        {tab === "assignments" && (
          <AssignmentsTab
            assignments={assignments}
            members={members}
            onChanged={loadAll}
          />
        )}
        {tab === "members" && <MembersTab members={members} />}
      </div>
    </div>
  )
}

function AskTab({
  question, setQuestion, convening, onAsk, error, active, sessions, onSelect, memberTitle, memberCount,
}: {
  question: string
  setQuestion: (v: string) => void
  convening: boolean
  onAsk: () => void
  error: string | null
  active: CouncilSession | null
  sessions: CouncilSession[]
  onSelect: (s: CouncilSession) => void
  memberTitle: (id: string) => string
  memberCount: number
}) {
  return (
    <div className="flex flex-col gap-5 max-w-3xl">
      <div className="flex flex-col gap-2">
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Should we take the enterprise deal that needs a 3-month custom build?"
          rows={3}
          disabled={convening}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); onAsk() }
          }}
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {memberCount} member{memberCount === 1 ? "" : "s"} will answer independently
          </span>
          <Button size="sm" disabled={!question.trim() || convening} onClick={onAsk}>
            {convening ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {convening ? "Convening…" : "Convene"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {active && <SessionDetail session={active} memberTitle={memberTitle} />}

      {sessions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Past sessions</span>
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s)}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60",
                active?.id === s.id && "border-foreground",
              )}
            >
              <div className="truncate font-medium">{s.question}</div>
              <div className="text-xs text-muted-foreground">
                {new Date(s.createdAt).toLocaleString()} · {s.positions.length} positions
                {s.synthesis && s.synthesis.disagreements.length > 0
                  ? ` · ${s.synthesis.disagreements.length} disagreement${s.synthesis.disagreements.length === 1 ? "" : "s"}`
                  : ""}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SessionDetail({ session, memberTitle }: { session: CouncilSession; memberTitle: (id: string) => string }) {
  const s = session.synthesis
  const failed = session.positions.filter((p) => !p.position)
  return (
    <div className="flex flex-col gap-5 rounded-lg border p-4">
      <div>
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Question</div>
        <div className="mt-1 text-sm">{session.question}</div>
      </div>

      {session.synthesisError && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-700">
          Synthesis failed: {session.synthesisError}. The positions below are unaffected.
        </div>
      )}

      {s && (
        <div className="flex flex-col gap-4">
          <div className="text-[15px] font-medium leading-relaxed">{s.headline}</div>

          {s.positions.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm">
              {s.positions.map((p) => (
                <li key={p.memberId}>
                  <span className="font-medium">{memberTitle(p.memberId)}</span>
                  <span className="text-muted-foreground"> — {p.summary}</span>
                </li>
              ))}
            </ul>
          )}

          {/* Never collapsed: this is the reason to convene rather than ask once. */}
          <div className="rounded-md border bg-muted/40 p-3">
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <AlertTriangle className="size-3.5" />
              Disagreements
            </div>
            {s.disagreements.length === 0 ? (
              <div className="mt-2 text-sm text-muted-foreground">None material.</div>
            ) : (
              <ul className="mt-2 flex flex-col gap-2.5 text-sm">
                {s.disagreements.map((d, i) => (
                  <li key={i}>
                    <div className="font-medium">{d.between.map(memberTitle).join(" vs ")}</div>
                    <div className="text-muted-foreground">{d.conflict}</div>
                    <div className="mt-0.5">Follow: {d.recommendation}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {s.openQuestions.length > 0 && (
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Open questions</div>
              <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-sm">
                {s.openQuestions.map((q, i) => <li key={i}>{q}</li>)}
              </ul>
            </div>
          )}

          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Next action</div>
            <div className="mt-1 text-sm">
              {s.nextAction.action} — <span className="font-medium">{s.nextAction.owner}</span>, {s.nextAction.when}
            </div>
          </div>
        </div>
      )}

      <details className="group">
        <summary className="cursor-pointer text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Positions, verbatim ({session.positions.length})
        </summary>
        <div className="mt-3 flex flex-col gap-4">
          {session.positions.map((p) => (
            <div key={p.memberId} className="rounded-md border p-3">
              <div className="text-sm font-medium">{p.title}</div>
              {!p.position ? (
                // Shown, not hidden — a silently absent member looks like assent.
                <div className="mt-1 text-sm text-amber-600">No position: {p.error ?? "no answer returned"}</div>
              ) : (
                <div className="mt-1.5 flex flex-col gap-1.5 text-sm">
                  <div><span className="text-muted-foreground">Position. </span>{p.position.position}</div>
                  {p.position.why.length > 0 && (
                    <div>
                      <span className="text-muted-foreground">Why. </span>
                      <ul className="mt-0.5 list-disc pl-5">
                        {p.position.why.map((w, i) => <li key={i}>{w}</li>)}
                      </ul>
                    </div>
                  )}
                  <div><span className="text-muted-foreground">Risk. </span>{p.position.risk}</div>
                  <div><span className="text-muted-foreground">Unknown. </span>{p.position.unknown}</div>
                  {p.position.notMine && (
                    <div><span className="text-muted-foreground">Not mine. </span>{p.position.notMine}</div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </details>

      {failed.length > 0 && (
        <div className="text-xs text-amber-600">
          {failed.length} member{failed.length === 1 ? "" : "s"} did not answer — the memo reflects only those that did.
        </div>
      )}
    </div>
  )
}

function AssignmentsTab({
  assignments, members, onChanged,
}: {
  assignments: Assignment[]
  members: CouncilMember[]
  onChanged: () => Promise<void>
}) {
  const [title, setTitle] = useState("")
  const [assignee, setAssignee] = useState<string>("")
  const [creating, setCreating] = useState(false)
  const [blockingId, setBlockingId] = useState<string | null>(null)
  const [blockReason, setBlockReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    const t = title.trim()
    if (!t || creating) return
    setCreating(true)
    setError(null)
    const res = await window.ipc.invoke("council:createAssignment", {
      title: t,
      assigneeId: assignee || null,
    })
    if (res.error) setError(res.error)
    else { setTitle(""); await onChanged() }
    setCreating(false)
  }

  const setStatus = async (a: Assignment, status: Assignment["status"]) => {
    // Blocking without a reason is refused by core; ask for one here rather
    // than surfacing that as an error after the fact.
    if (status === "blocked") { setBlockingId(a.id); setBlockReason(a.blockedReason ?? ""); return }
    setError(null)
    const res = await window.ipc.invoke("council:updateAssignment", { id: a.id, status })
    if (res.error) setError(res.error)
    await onChanged()
  }

  const confirmBlock = async () => {
    if (!blockingId) return
    const res = await window.ipc.invoke("council:updateAssignment", {
      id: blockingId, status: "blocked", blockedReason: blockReason,
    })
    if (res.error) setError(res.error)
    else { setBlockingId(null); setBlockReason(""); await onChanged() }
  }

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing?"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void create() } }}
          />
        </div>
        <select
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">Unassigned</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
        </select>
        <Button size="sm" disabled={!title.trim() || creating} onClick={() => void create()}>
          <Plus className="size-3.5" />
          Add
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {assignments.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          Nothing assigned yet.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {assignments.map((a) => (
            <div key={a.id} className="rounded-md border px-3 py-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className={cn("text-sm", a.status === "done" && "line-through text-muted-foreground")}>
                    {a.title}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs">
                    <span className={STATUS_STYLES[a.status]}>{STATUS_LABELS[a.status]}</span>
                    <span className="text-muted-foreground">
                      {a.assigneeId ? members.find((m) => m.id === a.assigneeId)?.title ?? a.assigneeId : "Unassigned"}
                    </span>
                  </div>
                  {a.status === "blocked" && a.blockedReason && (
                    <div className="mt-1 text-xs text-amber-600">Blocked: {a.blockedReason}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {a.status !== "done" && (
                    <Button variant="ghost" size="sm" onClick={() => void setStatus(a, "done")}>
                      <Check className="size-3.5" />
                    </Button>
                  )}
                  {a.status !== "blocked" && a.status !== "done" && (
                    <Button variant="ghost" size="sm" onClick={() => void setStatus(a, "blocked")}>
                      <AlertTriangle className="size-3.5" />
                    </Button>
                  )}
                  {a.status === "blocked" && (
                    <Button variant="ghost" size="sm" onClick={() => void setStatus(a, "open")}>
                      Unblock
                    </Button>
                  )}
                </div>
              </div>

              {blockingId === a.id && (
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    autoFocus
                    value={blockReason}
                    onChange={(e) => setBlockReason(e.target.value)}
                    placeholder="Why is this blocked?"
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void confirmBlock() } }}
                  />
                  <Button size="sm" disabled={!blockReason.trim()} onClick={() => void confirmBlock()}>Save</Button>
                  <Button variant="ghost" size="sm" onClick={() => setBlockingId(null)}>
                    <X className="size-3.5" />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function MembersTab({ members }: { members: CouncilMember[] }) {
  return (
    <div className="flex flex-col gap-3 max-w-3xl">
      <p className="text-sm text-muted-foreground">
        Charters live as Markdown in <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">~/.dhow/council/members/</code> — edit
        them there and they take effect on the next question.
      </p>
      {members.map((m) => (
        <div key={m.id} className="rounded-md border p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{m.title}</span>
            {!m.enabled && <span className="text-xs text-muted-foreground">Stood down</span>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground leading-relaxed">{m.mission}</p>
          {m.owns.length > 0 && (
            <div className="mt-2 text-xs text-muted-foreground">
              <span className="font-medium">Owns:</span> {m.owns.join(" · ")}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

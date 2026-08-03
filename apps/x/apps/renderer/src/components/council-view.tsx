"use client"

import type { ReactNode } from "react"
import { useCallback, useEffect, useState } from "react"
import { Loader2, Users, ListTodo, AlertTriangle, Plus, Check, X, Paperclip, MessagesSquare, Landmark, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { Assignment, CouncilAttachment, CouncilMember, CouncilSession } from "@x/shared/dist/council.js"

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
  // Which members answer. Defaults to the core four: eleven simultaneous
  // positions is a document, not a decision.
  const [selected, setSelected] = useState<string[]>([])
  const [discuss, setDiscuss] = useState(false)
  const [attachments, setAttachments] = useState<CouncilAttachment[]>([])
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
    setSelected((prev) => prev.length
      ? prev
      : m.members.filter((x) => x.enabled && x.group === 'core').map((x) => x.id))
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
      const res = await window.ipc.invoke("council:convene", {
        question: q,
        memberIds: selected,
        attachments,
        discuss,
      })
      if (res.error || !res.session) {
        setError(res.error ?? "The council returned nothing.")
      } else {
        setActive(res.session)
        setQuestion("")
        setAttachments([])
        await loadAll()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setConvening(false)
    }
  }, [question, convening, selected, attachments, discuss, loadAll])

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
            members={members}
            selected={selected}
            setSelected={setSelected}
            discuss={discuss}
            setDiscuss={setDiscuss}
            attachments={attachments}
            setAttachments={setAttachments}
            setError={setError}
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
  question, setQuestion, convening, onAsk, error, active, sessions, onSelect, memberTitle,
  members, selected, setSelected, discuss, setDiscuss, attachments, setAttachments, setError,
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
  members: CouncilMember[]
  selected: string[]
  setSelected: (v: string[]) => void
  discuss: boolean
  setDiscuss: (v: boolean) => void
  attachments: CouncilAttachment[]
  setAttachments: (v: CouncilAttachment[]) => void
  setError: (v: string | null) => void
}) {
  const enabled = members.filter((m) => m.enabled)
  const core = enabled.filter((m) => m.group === "core")
  const csuite = enabled.filter((m) => m.group === "csuite")
  const other = enabled.filter((m) => m.group !== "core" && m.group !== "csuite")

  const toggle = (id: string) =>
    setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])

  const setRoster = (ids: string[]) => setSelected(ids)

  const attach = async () => {
    const picked = await window.ipc.invoke("dialog:openFiles", { title: "Attach documents for review" })
    if (picked.paths.length === 0) return
    const res = await window.ipc.invoke("council:readAttachments", { paths: picked.paths })
    if (res.errors.length > 0) setError(res.errors.map((e) => e.error).join(" "))
    if (res.attachments.length > 0) setAttachments([...attachments, ...res.attachments])
  }

  const roster = (label: string, icon: ReactNode, group: CouncilMember[]) =>
    group.length === 0 ? null : (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {icon}
            {label}
          </span>
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setRoster(group.map((m) => m.id))}
          >
            only these
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {group.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => toggle(m.id)}
              title={m.mission}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                selected.includes(m.id)
                  ? "border-foreground bg-muted font-medium"
                  : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              {m.title}
            </button>
          ))}
        </div>
      </div>
    )

  return (
    <div className="flex flex-col gap-5 max-w-3xl">
      <div className="flex flex-col gap-3">
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

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {attachments.map((a, i) => (
              <span key={`${a.name}-${i}`} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
                <Paperclip className="size-3" />
                {a.name}
                {a.truncated && <span className="text-amber-600">truncated</span>}
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-3 rounded-md border p-3">
          {roster("Core", <Users className="size-3.5" />, core)}
          {roster("Cabinet", <Landmark className="size-3.5" />, csuite)}
          {roster("Custom", <Users className="size-3.5" />, other)}

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={discuss}
              onChange={(e) => setDiscuss(e.target.checked)}
              className="mt-0.5"
            />
            <span className="flex flex-col">
              <span className="inline-flex items-center gap-1.5">
                <MessagesSquare className="size-3.5" />
                Let them discuss
              </span>
              {/* Say what it costs, since it doubles the calls. */}
              <span className="text-xs text-muted-foreground">
                Adds a second round where each member reads the others and may change their mind. Doubles the model calls.
              </span>
            </span>
          </label>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void attach()} disabled={convening}>
              <Paperclip className="size-3.5" />
              Attach
            </Button>
            <span className="text-xs text-muted-foreground">
              {selected.length === 0
                ? "Pick at least one member"
                : `${selected.length} member${selected.length === 1 ? "" : "s"} answer independently`}
            </span>
          </div>
          <Button size="sm" disabled={!question.trim() || convening || selected.length === 0} onClick={onAsk}>
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
                {s.discussed ? " · discussed" : ""}
                {s.attachments.length > 0 ? ` · ${s.attachments.length} doc${s.attachments.length === 1 ? "" : "s"}` : ""}
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
        {session.attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {session.attachments.map((a, i) => (
              <span key={`${a.name}-${i}`} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs text-muted-foreground">
                <Paperclip className="size-3" />
                {a.name}
                {a.truncated && <span className="text-amber-600">truncated</span>}
              </span>
            ))}
          </div>
        )}
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

          {session.discussed && (
            <div className="rounded-md border p-3">
              <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <MessagesSquare className="size-3.5" />
                After discussion
              </div>
              <ul className="mt-2 flex flex-col gap-2 text-sm">
                {session.positions.filter((p) => p.rebuttal).map((p) => (
                  <li key={p.memberId}>
                    <span className="font-medium">{p.title}</span>
                    <span className={cn("ml-1.5 text-xs", p.rebuttal!.changedMind ? "text-amber-600" : "text-muted-foreground")}>
                      {p.rebuttal!.changedMind ? "changed position" : "held"}
                    </span>
                    <div className="text-muted-foreground">{p.rebuttal!.revisedPosition}</div>
                    <div className="text-xs text-muted-foreground">{p.rebuttal!.reasoning}</div>
                  </li>
                ))}
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
  const [dispatching, setDispatching] = useState<string | null>(null)
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

  const dispatch = async (a: Assignment) => {
    setDispatching(a.id)
    setError(null)
    const res = await window.ipc.invoke("council:dispatchAssignment", { id: a.id })
    if (res.error) setError(res.error)
    await onChanged()
    setDispatching(null)
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
                  {a.result && (
                    <details className="mt-1.5">
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        Result from {members.find((m) => m.id === a.assigneeId)?.title ?? a.assigneeId}
                      </summary>
                      {/* Returned, not accepted — only the principal marks it done. */}
                      <pre className="mt-1.5 whitespace-pre-wrap rounded-md bg-muted/60 p-2 text-xs font-sans">{a.result}</pre>
                    </details>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {a.assigneeId && a.status !== "done" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      title={`Hand this to the ${members.find((m) => m.id === a.assigneeId)?.title ?? a.assigneeId} and keep the result`}
                      disabled={dispatching === a.id}
                      onClick={() => void dispatch(a)}
                    >
                      {dispatching === a.id ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                    </Button>
                  )}
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

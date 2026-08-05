"use client"

import type { ReactNode } from "react"
import { useCallback, useEffect, useState } from "react"
import { Loader2, Users, ListTodo, AlertTriangle, Plus, Check, X, Paperclip, MessagesSquare, Landmark, Send, Pencil, Wrench } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { Assignment, CouncilAttachment, CouncilMember, CouncilSession } from "@x/shared/dist/council.js"
import { ChatInputWithMentions, type StagedAttachment } from "@/components/chat-input-with-mentions"
import type { FileMention, PromptInputMessage } from "@/components/ai-elements/prompt-input"
import { MessageResponse } from "@/components/ai-elements/message"

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

export interface CouncilViewProps {
  /** Passed straight through to the standard composer so @-mentions work. */
  knowledgeFiles: string[]
  recentFiles: string[]
  visibleFiles: string[]
}

export function CouncilView({ knowledgeFiles, recentFiles, visibleFiles }: CouncilViewProps) {
  const [tab, setTab] = useState<Tab>("ask")
  const [members, setMembers] = useState<CouncilMember[]>([])
  const [sessions, setSessions] = useState<CouncilSession[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])

  // Which members answer. Defaults to the core four: eleven simultaneous
  // positions is a document, not a decision.
  const [selected, setSelected] = useState<string[]>([])
  const [discuss, setDiscuss] = useState(false)
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

  /**
   * The composer hands back staged attachments and @-mentions as vault paths.
   * Both are documents the council should read, so they are resolved the same
   * way — a mentioned note is no less a document than a dragged-in file.
   */
  const ask = useCallback(async (
    message: PromptInputMessage,
    mentions?: FileMention[],
    staged?: StagedAttachment[],
  ) => {
    const q = message.text.trim()
    if (!q || convening || selected.length === 0) return
    setConvening(true)
    setError(null)
    try {
      const paths = [
        ...(staged ?? []).map((a) => a.path),
        ...(mentions ?? []).map((m) => m.path),
      ]
      let docs: CouncilAttachment[] = []
      if (paths.length > 0) {
        const read = await window.ipc.invoke("council:readAttachments", { paths })
        docs = read.attachments
        if (read.errors.length > 0) setError(read.errors.map((e) => e.error).join(" "))
      }
      const res = await window.ipc.invoke("council:convene", {
        question: q,
        memberIds: selected,
        attachments: docs,
        discuss,
      })
      if (res.error || !res.session) {
        setError(res.error ?? "The council returned nothing.")
      } else {
        setActive(res.session)
        await loadAll()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setConvening(false)
    }
  }, [convening, selected, discuss, loadAll])

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

      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4">
        {tab === "ask" && (
          <AskTab
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
          />
        )}
        {tab === "assignments" && (
          <AssignmentsTab
            assignments={assignments}
            members={members}
            onChanged={loadAll}
          />
        )}
        {tab === "members" && <MembersTab members={members} onChanged={loadAll} />}
      </div>

      {/* Docked, not scrolled with the transcript — the same shape as chat and
          the email composer, so the input stays put as sessions grow. */}
      {tab === "ask" && (
        <div className="shrink-0 border-t px-6 py-3">
          <ChatInputWithMentions
            knowledgeFiles={knowledgeFiles}
            recentFiles={recentFiles}
            visibleFiles={visibleFiles}
            onSubmit={ask}
            isProcessing={convening}
            isActive={selected.length > 0}
          />
        </div>
      )}
    </div>
  )
}

function AskTab({
  error, active, sessions, onSelect, memberTitle,
  members, selected, setSelected, discuss, setDiscuss,
}: {
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
}) {
  const enabled = members.filter((m) => m.enabled)
  const core = enabled.filter((m) => m.group === "core")
  const csuite = enabled.filter((m) => m.group === "csuite")
  const other = enabled.filter((m) => m.group !== "core" && m.group !== "csuite")

  const toggle = (id: string) =>
    setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])

  const setRoster = (ids: string[]) => setSelected(ids)


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
      {/* Roster and mode sit above the composer; the composer itself is the
          standard one, so attachments, @-mentions, dictation and drafts behave
          exactly as they do everywhere else in Dhow. */}
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
            <span className="text-xs text-muted-foreground">
              Adds a second round where each member reads the others and may change their mind. Doubles the model calls.
            </span>
          </span>
        </label>

        <div className="text-xs text-muted-foreground">
          {selected.length === 0
            ? "Pick at least one member"
            : `${selected.length} member${selected.length === 1 ? "" : "s"} answer independently · attach or @-mention documents for them to review`}
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
                      {/* Returned, not accepted — only the principal marks it done.
                          Rendered with the same markdown component as chat, so a
                          member handing back a table or code block reads as one. */}
                      <div className="mt-1.5 rounded-md bg-muted/60 p-3 text-sm">
                        <MessageResponse>{a.result}</MessageResponse>
                      </div>
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

/**
 * The read-ish domains a principal may grant from this editor. Deliberately
 * short of the full tool surface — no `shell`, `code`, `composio`,
 * `notifications`, `background-tasks`. Main's charter table (charters.ts)
 * records why: a council member advises, it does not act, and a seat that
 * could quietly send mail or run a command is a different product. `mcp` is
 * left off too, but for a different reason — mcp.json ships with zero
 * servers configured, so granting it today would be an option that visibly
 * does nothing. It reappears here once a server exists to grant it to.
 */
const GRANTABLE_TOOL_DOMAINS: { id: string; label: string }[] = [
  { id: "files", label: "Files" },
  { id: "web", label: "Web" },
  { id: "parsing", label: "Parsing" },
  { id: "browser", label: "Browser" },
  { id: "memory", label: "Memory" },
  { id: "live-note", label: "Live notes" },
  { id: "app", label: "App" },
  { id: "models", label: "Models" },
  { id: "agent-analysis", label: "Agent analysis" },
]

const TOOL_DOMAIN_LABELS: Record<string, string> = Object.fromEntries(
  GRANTABLE_TOOL_DOMAINS.map((d) => [d.id, d.label]),
)

function MembersTab({ members, onChanged }: { members: CouncilMember[]; onChanged: () => Promise<void> }) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTools, setDraftTools] = useState<string[]>([])
  const [draftMaxCalls, setDraftMaxCalls] = useState(12)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const startEdit = (m: CouncilMember) => {
    setEditingId(m.id)
    // Copy, don't reset — a domain granted by hand-editing the Markdown
    // (say `mcp`, or something outside the offered set entirely) survives
    // an edit here untouched. This picker only ever adds or removes from
    // the read-ish set; it never silently drops what it doesn't understand.
    setDraftTools([...m.tools])
    setDraftMaxCalls(m.maxModelCalls)
    setError(null)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setError(null)
  }

  const toggleDomain = (id: string) =>
    setDraftTools((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const save = async (m: CouncilMember) => {
    setSaving(true)
    setError(null)
    const res = await window.ipc.invoke("council:saveMember", {
      member: { ...m, tools: draftTools, maxModelCalls: draftMaxCalls },
    })
    setSaving(false)
    if (!res.ok) { setError("Could not save the grant."); return }
    setEditingId(null)
    await onChanged()
  }

  return (
    <div className="flex flex-col gap-3 max-w-3xl">
      <p className="text-sm text-muted-foreground">
        Charters live as Markdown in <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">~/.dhow/council/members/</code> — edit
        them there for mission and remit. Tool grants and the call ceiling live in the same file and can be edited below.
      </p>
      {members.map((m) => {
        const editing = editingId === m.id
        // Anything already granted outside the offered set — a hand-edited
        // `mcp`, or a domain this picker deliberately excludes — stays
        // visible rather than vanishing into the toggle row.
        const extraTools = draftTools.filter((t) => !TOOL_DOMAIN_LABELS[t])
        return (
          <div key={m.id} className="rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{m.title}</span>
              <div className="flex items-center gap-2">
                {!m.enabled && <span className="text-xs text-muted-foreground">Stood down</span>}
                {!editing && (
                  <Button variant="ghost" size="sm" onClick={() => startEdit(m)}>
                    <Pencil className="size-3.5" />
                    Edit grant
                  </Button>
                )}
              </div>
            </div>
            <p className="mt-1 text-sm text-muted-foreground leading-relaxed">{m.mission}</p>
            {m.owns.length > 0 && (
              <div className="mt-2 text-xs text-muted-foreground">
                <span className="font-medium">Owns:</span> {m.owns.join(" · ")}
              </div>
            )}

            {/* No tools reads as advisory-only, on purpose — but that has to
                be a visible statement, not a blank space the principal has
                to interpret. */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Wrench className="size-3 text-muted-foreground shrink-0" />
              {m.tools.length === 0 ? (
                <span className="text-xs text-muted-foreground">Advisory only — one model call, touches nothing</span>
              ) : (
                <>
                  {m.tools.map((t) => (
                    <span key={t} className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
                      {TOOL_DOMAIN_LABELS[t] ?? t}
                    </span>
                  ))}
                  <span className="text-[11px] text-muted-foreground">· up to {m.maxModelCalls} model calls</span>
                </>
              )}
            </div>

            {editing && (
              <div className="mt-3 flex flex-col gap-2.5 rounded-md border border-dashed p-2.5">
                <div className="flex flex-wrap gap-1.5">
                  {GRANTABLE_TOOL_DOMAINS.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => toggleDomain(d.id)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs transition-colors",
                        draftTools.includes(d.id)
                          ? "border-foreground bg-muted font-medium"
                          : "text-muted-foreground hover:bg-muted/60",
                      )}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>

                {extraTools.length > 0 && (
                  <div className="text-[11px] text-muted-foreground">
                    Also granted by a hand-edited charter, not offered here: {extraTools.join(", ")}
                  </div>
                )}

                {draftTools.length > 0 && (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    Model call ceiling
                    <Input
                      type="number"
                      min={1}
                      max={50}
                      value={draftMaxCalls}
                      onChange={(e) => setDraftMaxCalls(
                        Math.min(50, Math.max(1, Math.round(Number(e.target.value)) || 1)),
                      )}
                      className="h-7 w-16 px-2 text-xs"
                    />
                  </label>
                )}

                {/* The cost, honestly, in one line — not a paragraph. */}
                <p className="text-xs text-muted-foreground">
                  {draftTools.length === 0
                    ? "Answers in a single model call — fast, cheap, and unable to touch anything."
                    : `Runs as a multi-turn agent instead of a single call — slower and costlier, up to ${draftMaxCalls} model calls per question.`}
                </p>

                {error && <p className="text-xs text-destructive">{error}</p>}

                <div className="flex items-center gap-2">
                  <Button size="sm" disabled={saving} onClick={() => void save(m)}>
                    {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                    Save
                  </Button>
                  <Button variant="ghost" size="sm" disabled={saving} onClick={cancelEdit}>
                    <X className="size-3.5" />
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

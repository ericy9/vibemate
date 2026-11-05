import type { AggregatedSession, AggregatedSnapshot } from "./environment-types.js";

export type NoticeKind = "completed" | "failed" | "waiting_permission";

export interface TaskNotice {
  /** Session identity; matches the renderer's `${environmentId}/${agent}/${sessionId}`. */
  id: string;
  kind: NoticeKind;
  environmentName: string;
  project: string | undefined;
  agent: AggregatedSession["agent"];
  at: string;
}

const NOTICE_KINDS = new Set<string>(["completed", "failed", "waiting_permission"]);
/** A session seen for the first time only notifies if its last event is this recent (avoids replaying history on connect). */
const FRESH_WINDOW_MS = 15_000;

export function sessionIdentity(session: Pick<AggregatedSession, "environmentId" | "agent" | "sessionId">): string {
  return `${session.environmentId}/${session.agent}/${session.sessionId}`;
}

/** Last path segment of the most recent cwd the session reported, for Windows or POSIX paths. */
export function projectName(session: Pick<AggregatedSession, "recentEvents">): string | undefined {
  for (let index = session.recentEvents.length - 1; index >= 0; index -= 1) {
    const cwd = session.recentEvents[index]?.cwd;
    if (!cwd) continue;
    const name = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    if (name) return name;
  }
  return undefined;
}

/**
 * Turns successive aggregated snapshots into "this task needs a look" notices.
 * A notice fires when a session enters completed / failed / waiting_permission,
 * or produces a new event while staying in one of those states (e.g. a second permission prompt).
 */
export class TaskNotifier {
  private readonly seen = new Map<string, string>();

  diff(snapshot: Pick<AggregatedSnapshot, "sessions">, now = Date.now()): TaskNotice[] {
    const notices: TaskNotice[] = [];
    const present = new Set<string>();
    for (const session of snapshot.sessions) {
      const id = sessionIdentity(session);
      present.add(id);
      const signature = `${session.state}|${session.updatedAt}`;
      const previous = this.seen.get(id);
      this.seen.set(id, signature);
      if (previous === signature || !NOTICE_KINDS.has(session.state)) continue;
      if (previous === undefined && now - Date.parse(session.updatedAt) > FRESH_WINDOW_MS) continue;
      notices.push({
        id,
        kind: session.state as NoticeKind,
        environmentName: session.environmentName,
        project: projectName(session),
        agent: session.agent,
        at: session.updatedAt,
      });
    }
    for (const id of this.seen.keys()) {
      if (!present.has(id)) this.seen.delete(id);
    }
    return notices;
  }
}

const AGENT_NAMES: Record<string, string> = { codex: "Codex", copilot: "Copilot" };
const KIND_TEXT: Record<NoticeKind, string> = {
  completed: "已完成",
  failed: "失败了",
  waiting_permission: "需要你确认",
};

export function describeNotice(notice: TaskNotice): { title: string; body: string } {
  const agent = AGENT_NAMES[notice.agent] ?? notice.agent;
  return {
    title: `${notice.project ?? agent} ${KIND_TEXT[notice.kind]}`,
    body: `${notice.environmentName} · ${agent}`,
  };
}

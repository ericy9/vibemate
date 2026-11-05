import assert from "node:assert/strict";
import test from "node:test";
import type { AggregatedSession } from "./environment-types.js";
import { describeNotice, projectName, TaskNotifier } from "./task-notifier.js";

const NOW = Date.parse("2026-11-05T10:00:00.000Z");

function session(state: AggregatedSession["state"], updatedAt: string, cwd?: string): AggregatedSession {
  return {
    key: "k", sourceProfile: "default", agent: "codex", sessionId: "s1", state, updatedAt,
    recentEvents: cwd ? [{ cwd } as AggregatedSession["recentEvents"][number]] : [],
    deviceId: "d1", environmentId: "e1", environmentName: "树莓派",
  };
}

test("notifies when a running task completes", () => {
  const notifier = new TaskNotifier();
  assert.deepEqual(notifier.diff({ sessions: [session("working", "2026-11-05T09:59:50.000Z")] }, NOW), []);
  const [notice] = notifier.diff({ sessions: [session("completed", "2026-11-05T09:59:58.000Z", "/home/pi/vibemate")] }, NOW);
  assert.equal(notice?.kind, "completed");
  assert.equal(notice?.project, "vibemate");
  assert.deepEqual(describeNotice(notice!), { title: "vibemate 已完成", body: "树莓派 · Codex" });
});

test("does not repeat the same state or replay old history on connect", () => {
  const notifier = new TaskNotifier();
  assert.deepEqual(notifier.diff({ sessions: [session("completed", "2026-11-05T09:00:00.000Z")] }, NOW), []);
  const fresh = session("waiting_permission", "2026-11-05T09:59:59.000Z");
  assert.equal(notifier.diff({ sessions: [fresh] }, NOW).length, 1);
  assert.equal(notifier.diff({ sessions: [fresh] }, NOW).length, 0);
  assert.equal(notifier.diff({ sessions: [session("waiting_permission", "2026-11-05T10:00:00.000Z")] }, NOW).length, 1);
});

test("project name handles Windows paths and trailing separators", () => {
  assert.equal(projectName({ recentEvents: [{ cwd: "C:\\code\\demo\\" } as never] }), "demo");
  assert.equal(projectName({ recentEvents: [] }), undefined);
});

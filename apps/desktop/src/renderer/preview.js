const $ = id => document.getElementById(id);
const api = window.vibemate;
const priorities = { waiting_permission: 6, failed: 5, thinking: 3, working: 3, completed: 2 };
const labels = { thinking: '思考中', working: '进行中', waiting_permission: '待处理', failed: '失败', completed: '完成' };
const COMPLETED_TTL = 300_000;
const DOT_AFTER_EMPTY = 30_000;
const COLLAPSE_DELAY = 3_000;
const DRAG_THRESHOLD = 4;
const MAX_ROWS = 5;
const TOAST_DURATION = 6_000;
const noticeText = { completed: '已完成', failed: '失败了', waiting_permission: '需要你' };

let snapshot = {};
let expanded = location.hash==='#exp';
let hovered = false;
let emptySince = Date.now();
let collapseTimer;
let toast; // { id, kind, text, extra }
let toastTimer;
let highlightId;
const pendingCommands = new Set();
const identity = item => `${item.environmentId}/${item.agent}/${item.sessionId}`;

function visibleTasks(value) {
  const now = Date.now();
  return (value.sessions ?? [])
    .filter(s => priorities[s.state] && (s.state !== 'completed' || now - Date.parse(s.updatedAt) < COMPLETED_TTL))
    .sort((a, b) => priorities[b.state] - priorities[a.state] || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function currentMode(taskCount) {
  if (expanded) return 'expanded';
  if (toast) return 'toast';
  if (taskCount === 0 && Date.now() - emptySince > DOT_AFTER_EMPTY) return 'dot';
  return 'capsule';
}

let reportScheduled = false;
function reportState() {
  if (reportScheduled) return;
  reportScheduled = true;
  requestAnimationFrame(() => {
    reportScheduled = false;
    const monitor = $('monitor');
    api.reportPreviewState?.({
      mode: monitor.dataset.mode,
      width: Math.ceil(monitor.offsetWidth),
      height: Math.ceil(monitor.offsetHeight),
      hovered,
    });
  });
}

function buildTask(session, value, permissions) {
  const key = identity(session);
  const request = permissions.find(p => identity(p) === key);
  const env = (value.environments ?? []).find(e => e.environmentId === session.environmentId);
  const offline = env?.status !== 'connected';
  const attention = ['waiting_permission', 'failed'].includes(session.state);
  const agentName = session.agent === 'codex' ? 'Codex' : 'Copilot';

  const card = document.createElement('div');
  card.className = `task state-${session.state}${attention ? ' needs-attention' : ''}${offline ? ' offline' : ''}${key === highlightId ? ' highlight' : ''}`;

  const state = document.createElement('span'); state.className = 'task-state';
  const main = document.createElement('span'); main.className = 'task-main';
  const title = document.createElement('span'); title.className = 'task-title'; title.textContent = session.project ?? session.sessionId; title.title = `${session.project ?? ''} ${session.sessionId}`.trim();
  const meta = document.createElement('span'); meta.className = 'task-meta'; meta.textContent = `${session.environmentName ?? '本机'} · ${agentName}`;
  main.append(title, meta);
  const side = document.createElement('span'); side.className = 'task-side';
  side.textContent = offline ? '已断线'
    : session.agent === 'copilot' && session.state === 'waiting_permission' ? '回终端处理'
    : labels[session.state];
  card.append(state, main, side);

  if (request && request.agent === 'codex' && !offline) {
    const detail = document.createElement('p'); detail.className = 'task-detail';
    detail.textContent = request.tool.summary ?? request.tool.name;
    const actions = document.createElement('div'); actions.className = 'approval-actions';
    for (const [decision, label] of [['deny', '拒绝'], ['allow', '允许本次']]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.className = decision;
      button.disabled = pendingCommands.has(request.requestId);
      button.onclick = async () => {
        pendingCommands.add(request.requestId);
        actions.querySelectorAll('button').forEach(b => { b.disabled = true; });
        try {
          const result = await api.submitDecision({ environmentId: request.environmentId, requestId: request.requestId,
            sourceProfile: request.sourceProfile, agent: request.agent, sessionId: request.sessionId }, decision);
          $('feedback').textContent = result === 'accepted' ? '' : '请求已失效，请查看最新状态。';
        } catch { $('feedback').textContent = '未能提交，请检查连接或回原终端处理。'; }
        finally { pendingCommands.delete(request.requestId); render(snapshot); }
      };
      actions.append(button);
    }
    card.append(detail, actions);
  } else if (session.state === 'failed' && !offline) {
    const detail = document.createElement('p'); detail.className = 'task-detail';
    detail.textContent = '任务遇到问题，请回原终端查看原因。';
    card.append(detail);
  }
  return card;
}

function render(value) {
  snapshot = value;
  const permissions = value.pendingPermissions ?? [];
  const tasks = visibleTasks(value);
  if (tasks.length > 0) emptySince = Date.now();

  const running = tasks.filter(s => s.state === 'working' || s.state === 'thinking').length;
  const attention = new Set([
    ...tasks.filter(s => ['waiting_permission', 'failed'].includes(s.state)).map(identity),
    ...permissions.map(identity),
  ]).size;
  const done = tasks.filter(s => s.state === 'completed').length;
  const connected = (value.environments ?? []).filter(e => e.status === 'connected').length;

  const monitor = $('monitor');
  monitor.classList.toggle('has-attention', attention > 0);
  monitor.classList.toggle('offline', connected === 0);
  monitor.dataset.mode = currentMode(tasks.length);

  $('capsule-working').textContent = running;
  $('capsule-attention').textContent = attention;
  $('capsule-completed').textContent = done;
  $('capsule-working').parentElement.hidden = running === 0;
  $('capsule-attention').parentElement.hidden = attention === 0;
  $('capsule-completed').parentElement.hidden = done === 0;
  $('capsule-toast').hidden = !toast;
  if (toast) {
    $('capsule-toast').dataset.kind = toast.kind;
    $('capsule-toast-text').textContent = toast.text;
    $('capsule-toast-extra').textContent = toast.extra > 0 ? `+${toast.extra}` : '';
  }
  $('capsule-text').textContent = tasks.length === 0 ? (connected === 0 ? '未连接' : '空闲') : '';
  $('capsule').setAttribute('aria-label', attention ? `${attention} 个任务需要你，点击展开` : '展开任务监控');
  $('capsule').title = `${running} 进行中 · ${attention} 待处理 · ${done} 刚完成`;

  $('headline').textContent = attention ? `${attention} 个任务需要你` : running ? '任务正在进行' : done ? '刚刚完成' : '没有活跃任务';
  $('connection').textContent = `${connected} 个环境在线`;
  $('expanded').hidden = !expanded;

  const nodes = tasks.slice(0, MAX_ROWS).map(session => buildTask(session, value, permissions));
  if (tasks.length > MAX_ROWS) {
    const more = document.createElement('div'); more.className = 'empty'; more.textContent = `还有 ${tasks.length - MAX_ROWS} 项`; nodes.push(more);
  }
  if (!nodes.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '暂时没有活跃任务'; nodes.push(empty); }
  $('tasks').replaceChildren(...nodes);
  reportState();
}

function showNotice(notice) {
  const agent = notice.agent === 'codex' ? 'Codex' : 'Copilot';
  const text = `${notice.environmentName} · ${notice.project ?? agent} ${noticeText[notice.kind] ?? ''}`;
  // Notices arriving while one is still showing collapse into "+N" so nothing flickers past unseen.
  const extra = toast && toast.id !== notice.id ? toast.extra + 1 : toast?.extra ?? 0;
  toast = { id: notice.id, kind: notice.kind, text, extra };
  highlightId = notice.id;
  emptySince = Date.now();
  clearTimeout(toastTimer);
  const expire = () => {
    if (hovered) { toastTimer = setTimeout(expire, 1_000); return; }
    toast = undefined; render(snapshot);
  };
  toastTimer = setTimeout(expire, TOAST_DURATION);
  if (notice.expand) { toast = undefined; setExpanded(true); scheduleCollapse(); }
  render(snapshot);
}

function setExpanded(next) {
  if (expanded === next) return;
  expanded = next;
  if (next) { toast = undefined; clearTimeout(toastTimer); }
  if (!next) { $('feedback').textContent = ''; highlightId = undefined; }
  render(snapshot);
}

function scheduleCollapse() {
  clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => {
    if (!hovered && expanded && pendingCommands.size === 0) setExpanded(false);
  }, COLLAPSE_DELAY);
}

// Manual dragging keeps click-to-expand working (app-region drag swallows clicks).
function draggable(element, onClick) {
  element.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button:not(#capsule)')) return;
    const startX = event.screenX; const startY = event.screenY;
    let dragging = false;
    element.setPointerCapture(event.pointerId);
    const move = e => {
      const dx = e.screenX - startX; const dy = e.screenY - startY;
      if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!dragging) { dragging = true; api.dragPreview?.('start', 0, 0); }
      api.dragPreview?.('move', dx, dy);
    };
    const up = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      if (dragging) api.dragPreview?.('end', 0, 0);
      else onClick?.();
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
  });
}

draggable($('capsule'), () => setExpanded(true));
draggable($('expanded-header'));
$('collapse').onclick = () => setExpanded(false);
$('hide').onclick = () => api.hidePreview?.();
$('open-settings').onclick = () => api.showControlPanel();
document.body.addEventListener('mouseenter', () => { hovered = true; clearTimeout(collapseTimer); reportState(); });
document.body.addEventListener('mouseleave', () => { hovered = false; scheduleCollapse(); reportState(); });

api.onSnapshot(render);
api.onNotice?.(showNotice);
render(await api.getSnapshot());
setInterval(() => render(snapshot), 10_000);

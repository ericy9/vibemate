const panel = document.getElementById('panel-wrap');
const pet = document.getElementById('pet-wrap');
const stage = document.getElementById('stage');
const panelToggle = document.getElementById('toggle-panel');
const petToggle = document.getElementById('toggle-pet');
const PEEK = 8;
let panelDock; let panelHovered = false; let panelMode = 'capsule'; let dragOrigin;
window.hideFloat = () => { panel.hidden = true; panelToggle.textContent = '显示监控窗'; };
window.hidePet = () => { pet.hidden = true; petToggle.textContent = '显示桌宠'; };

// Mirrors the desktop main process: size from renderer, dock to the stage edges, peek when idle.
function applyPanelBounds() {
  if (dragOrigin) return;
  const width = panel.offsetWidth; const stageWidth = stage.clientWidth;
  const revealed = panelHovered || panelMode === 'expanded' || panelMode === 'toast';
  if (panelDock === 'left') panel.style.left = `${revealed ? 0 : -width + PEEK}px`;
  else if (panelDock === 'right') panel.style.left = `${revealed ? stageWidth - width : stageWidth - PEEK}px`;
  else if (panel.style.left) panel.style.left = `${Math.max(0, Math.min(stageWidth - width, parseFloat(panel.style.left)))}px`;
}
window.resizeFloat = state => {
  panelMode = state.mode; panelHovered = state.hovered;
  panel.style.width = `${state.width}px`; panel.style.height = `${state.height}px`;
  applyPanelBounds();
};
window.dragFloat = (phase, dx, dy) => {
  const rect = () => { const b = panel.getBoundingClientRect(); const s = stage.getBoundingClientRect(); return { x: b.left - s.left, y: b.top - s.top }; };
  if (phase === 'start') { dragOrigin = rect(); panel.style.bottom = 'auto'; panel.style.top = `${dragOrigin.y}px`; panel.style.left = `${dragOrigin.x}px`; return; }
  if (!dragOrigin) return;
  if (phase === 'move') { panel.style.left = `${dragOrigin.x + dx}px`; panel.style.top = `${dragOrigin.y + dy}px`; return; }
  const { x, y } = rect(); dragOrigin = undefined;
  panelDock = x <= 16 ? 'left' : x + panel.offsetWidth >= stage.clientWidth - 16 ? 'right' : undefined;
  panel.style.top = `${Math.max(0, Math.min(stage.clientHeight - panel.offsetHeight, y))}px`;
  applyPanelBounds();
};
panelToggle.onclick = () => { panel.hidden = !panel.hidden; panelToggle.textContent = panel.hidden ? '显示监控窗' : '隐藏监控窗'; };
petToggle.onclick = () => { pet.hidden = !pet.hidden; petToggle.textContent = pet.hidden ? '显示桌宠' : '隐藏桌宠'; };
window.openDashboard = () => {
  document.getElementById('dashboard-frame').src = '/shared-dashboard';
  document.getElementById('dashboard-dialog').showModal();
};
document.getElementById('dashboard').onclick = event => { event.preventDefault(); window.openDashboard(); };
document.getElementById('close-dashboard').onclick = () => document.getElementById('dashboard-dialog').close();
document.querySelectorAll('[data-mode]').forEach(button => { button.onclick = () => {
  window.monitorDemo(button.dataset.mode);
  document.querySelectorAll('[data-mode]').forEach(item => item.classList.toggle('active', item === button));
}; });
for (const element of [pet]) {
  const handle = element.querySelector('.grab');
  handle.onpointerdown = event => {
    if (event.button !== 0) return;
    const stage = document.getElementById('stage');
    const bounds = element.getBoundingClientRect(); const parent = stage.getBoundingClientRect();
    const dx = event.clientX - bounds.left; const dy = event.clientY - bounds.top;
    handle.setPointerCapture(event.pointerId);
    handle.onpointermove = move => {
      const left = Math.max(0, Math.min(parent.width - bounds.width, move.clientX - parent.left - dx));
      const top = Math.max(0, Math.min(parent.height - element.offsetHeight, move.clientY - parent.top - dy));
      Object.assign(element.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
    };
    handle.onpointerup = () => { handle.onpointermove = null; };
    handle.onpointercancel = () => { handle.onpointermove = null; };
  };
}
const floatFrame = document.getElementById('float-frame');
floatFrame.src = '/float-panel';
document.querySelectorAll('[data-notice]').forEach(button => { button.onclick = () => {
  const [sessionId, kind] = button.dataset.notice.split(':');
  window.simulateNotice(sessionId, kind);
}; });
document.getElementById('burst').onclick = () => {
  window.monitorDemo('working');
  [['传感器驱动', 'completed'], ['整理接口文档', 'completed'], ['运行项目测试', 'waiting_permission']]
    .forEach(([id, kind], index) => setTimeout(() => window.simulateNotice(id, kind), index * 400));
};
document.getElementById('pet-frame').src = '/pet';

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const desktop = new URL('../apps/desktop/src/renderer/', import.meta.url);
const banner = `<aside style="padding:16px 22px;background:#202c46;border-bottom:1px solid #405176">
  <strong>VibeMate · 实际监控面板预览</strong>
  <p style="margin:6px 0;color:#b8c7df">复用桌面端页面和样式，以下均为模拟数据。不会连接设备、扫描环境或执行命令。</p>
  <div style="display:flex;gap:10px;flex-wrap:wrap">
    <button onclick="window.monitorDemo('mixed')">混合任务与审批</button>
    <button onclick="window.monitorDemo('working')">工作中</button>
    <button onclick="window.monitorDemo('completed')">全部完成</button>
    <button onclick="window.monitorDemo('failed')">任务失败</button>
    <a href="http://10.188.0.34:18880/" style="color:#93c5fd">设备配置原型 ↗</a>
  </div><p id="demo-feedback" role="status" style="margin:8px 0 0;color:#b8c7df">可操作启停、Codex 审批开关和 Allow / Deny。切换场景会重置示例。</p>
</aside><script src="/monitor-mock.js"></script>`;

const routes = new Map([
  ['/styles.css', [new URL('styles.css', desktop), 'text/css']],
  ['/renderer.js', [new URL('renderer.js', desktop), 'text/javascript']],
  ['/monitor-mock.js', [new URL('monitor-mock.js', import.meta.url), 'text/javascript']],
  ['/floating', [new URL('floating.html', import.meta.url), 'text/html']],
  ['/floating.js', [new URL('floating.js', import.meta.url), 'text/javascript']],
  ...['preview.css', 'preview.js', 'pet-renderer.js', 'pet-window.css'].map(name => [`/${name}`, [new URL(name, desktop), name.endsWith('.css') ? 'text/css' : 'text/javascript']]),
  ...['idle', 'thinking', 'working', 'working-enter', 'working-exit', 'completed', 'failed', 'waiting-permission', 'permission-reminder', 'sleep', 'sleep-enter', 'wake'].map(name => [`/assets/pet/${name}.webm`, [new URL(`assets/pet/${name}.webm`, desktop), 'video/webm']]),
]);
const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const path = new URL(req.url, 'http://localhost').pathname;
    let body; let type;
    if (path === '/' || path === '/index.html') {
      body = (await readFile(new URL('index.html', desktop), 'utf8')).replace('<body>', '<body>' + banner);
      type = 'text/html';
    } else if (path === '/float-panel' || path === '/pet' || path === '/shared-dashboard') {
      const file = path === '/pet' ? 'pet.html' : path === '/shared-dashboard' ? 'index.html' : 'preview.html';
      body = (await readFile(new URL(file, desktop), 'utf8')).replace('<body>', `<body><script>
        window.vibemate={...parent.vibemate,showControlPanel:()=>parent.openDashboard(),
          hidePreview:()=>parent.hideFloat(),reportPreviewState:s=>parent.resizeFloat(s),
          dragPreview:(p,dx,dy)=>parent.dragFloat(p,dx,dy),
          quitApp:()=>parent.hidePet(),onSnapshot:listener=>{
            const unsubscribe=parent.vibemate.onSnapshot(listener);
            window.addEventListener('pagehide',unsubscribe,{once:true});return unsubscribe;
          }};
      </script>`);
      type = 'text/html';
    } else {
      const route = routes.get(path);
      if (!route) { res.writeHead(404).end(); return; }
      body = await readFile(route[0]); type = route[1];
    }
    res.writeHead(200, { 'content-type': type === 'video/webm' ? type : `${type}; charset=utf-8`, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(500).end('Preview unavailable'); }
});
server.listen(18883, '0.0.0.0', () => console.log('Monitoring preview: http://10.188.0.34:18883/'));

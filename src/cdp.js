// 极简 CDP 客户端：连接知犀桌面客户端的调试端口
import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_PORT = 19222;
const rawPort = Number(process.env.ZHIXI_CDP_PORT || DEFAULT_PORT);
// 端口来自环境变量，非法值直接兜底成默认，避免后续连接全用 NaN
const PORT = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : DEFAULT_PORT;
const HOST = '127.0.0.1';
const WS_OPEN_TIMEOUT = 10000;

export const getPort = () => PORT;

function httpJson(path, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: PORT, path, timeout }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`调试端口返回 HTTP ${res.statusCode}（${path}）`));
          return;
        }
        try { resolve(JSON.parse(d)); } catch {
          reject(new Error(`调试端口返回的不是 JSON（${path}）: ${d.slice(0, 100)}`));
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`调试端口响应超时（${timeout}ms，${path}）`)));
    req.on('error', (e) => {
      if (/超时/.test(e.message)) { reject(e); return; }
      reject(new Error(`连不上知犀客户端调试端口 ${PORT}（${e.code || e.message}）。确认客户端已启动且带 --remote-debugging-port=${PORT}`));
    });
  });
}

export async function listTargets() {
  const r = await httpJson('/json/list');
  if (!Array.isArray(r)) throw new Error('调试端口返回的目标列表格式异常（不是数组）');
  return r;
}

export const version = () => httpJson('/json/version');

// 从 editor.html?id=xxx 里取 fileId。用 URLSearchParams 而不是 split('id=')，
// 否则 URL 带 & 其它参数时会把 "&xxx" 一起当成 fileId。
export function parseFileId(url) {
  const q = String(url || '').split('?')[1];
  if (!q) return null;
  const v = new URLSearchParams(q.split('#')[0]).get('id');
  return v ? v : null;
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.closed = false;
  }

  static async connect(wsUrl, { timeout = WS_OPEN_TIMEOUT } = {}) {
    if (!wsUrl) throw new Error('页面缺少调试通道地址（webSocketDebuggerUrl），页面可能已关闭');
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`连接页面调试通道超时（${timeout}ms），页面可能在加载中或已崩溃`));
      }, timeout);
      const onOpen = () => { cleanup(); resolve(); };
      const onErr = () => { cleanup(); reject(new Error('无法连接页面调试通道（地址可能已失效，重新调用即可）')); };
      function cleanup() {
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onErr);
      }
      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onErr, { once: true });
    });

    const c = new Cdp(ws);
    // 页面被关掉/崩溃时，未返回的调用必须立刻失败，而不是干等 30 秒超时
    const abortAll = (why) => {
      c.closed = true;
      for (const [, p] of c.pending) {
        try { p.reject(new Error(why)); } catch { /* 忽略 */ }
      }
      c.pending.clear();
    };
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      const p = m.id && c.pending.get(m.id);
      if (!p) return;
      c.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || JSON.stringify(m.error)));
      else p.resolve(m.result);
    });
    ws.addEventListener('close', () => abortAll('页面调试通道已关闭（导图窗口被关闭或客户端退出）'));
    ws.addEventListener('error', () => abortAll('页面调试通道异常断开'));
    return c;
  }

  send(method, params = {}, timeout = 30000) {
    if (this.closed || !this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error(`页面调试通道已断开，无法执行 ${method}。请重试；若反复出现，重启知犀客户端。`));
    }
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`调试指令超时（${timeout}ms）：${method}`));
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`发送调试指令失败（${method}）：${e.message}`));
      }
    });
  }

  // 页面导航/崩溃时执行上下文会失效，自动重试一次比直接失败体验好
  async eval(expression, awaitPromise = true, { retries = 1 } = {}) {
    for (let i = 0; ; i++) {
      try {
        const r = await this.send('Runtime.evaluate', {
          expression, awaitPromise, returnByValue: true, userGesture: true,
        });
        if (r && r.exceptionDetails) {
          const d = (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text;
          throw new Error('页面执行出错: ' + d);
        }
        return r && r.result ? r.result.value : undefined;
      } catch (e) {
        const transient = /context|destroyed|Cannot find|Target closed|Session closed|已断开/i.test(e.message);
        if (i < retries && transient && !this.closed) {
          await sleep(400);
          continue;
        }
        throw e;
      }
    }
  }

  close() {
    if (this.closed) { try { this.ws.close(); } catch {} return; }
    for (const [, p] of this.pending) {
      try { p.reject(new Error('连接已被主动关闭')); } catch { /* 忽略 */ }
    }
    this.pending.clear();
    try { this.ws.close(); } catch {}
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 把某个页面切到前台。后台标签页的 visibilityState 是 hidden，
// 此时 Page.captureScreenshot 会一直等不到帧而超时（不是报错，是挂住）。
export async function activateTarget(targetId) {
  const v = await version();
  const b = await Cdp.connect(v.webSocketDebuggerUrl);
  try {
    await b.send('Target.activateTarget', { targetId }, 8000);
  } finally {
    b.close();
  }
}

const EXE = process.env.ZHIXI_EXE || 'C:\\Program Files\\ZhiXi\\ZXMind\\zhiximind-desktop.exe';
export const getExePath = () => EXE;

const LAUNCH_ARGS = [
  '--remote-allow-origins=*',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
];

// 客户端没跑就拉起来（带调试端口）
export async function ensureClient(waitMs = 30000) {
  try { await version(); return { started: false }; } catch { /* 没跑，往下走 */ }
  if (!existsSync(EXE)) {
    throw new Error(`知犀客户端未运行，且找不到程序文件：${EXE}。请手动启动知犀，或用环境变量 ZHIXI_EXE 指定路径。`);
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) delete env[k];

  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, ...LAUNCH_ARGS], {
    cwd: dirname(EXE), env, detached: true, stdio: 'ignore',
  });
  // 必须挂 error：spawn 失败（权限/文件被占用）时若不监听会抛未捕获异常，直接把 MCP 进程干掉
  let spawnErr = null;
  child.on('error', (e) => { spawnErr = e; });
  child.unref();

  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    if (spawnErr) break;
    await sleep(1200);
    try { await version(); return { started: true }; } catch { /* 还没起来 */ }
  }

  if (spawnErr) {
    throw new Error(`启动知犀客户端失败：${spawnErr.message}。可以手动双击 zhixi-mcp\\start-zhixi.cmd，或用 ZHIXI_EXE 指定正确路径。`);
  }
  // 端口一直没起来：多半是知犀已经在运行（单实例锁，新进程把参数转给旧进程就退出了）
  if (isClientRunning()) {
    throw new Error(
      '知犀已经在运行，但没有开调试端口（单实例限制，我拉不起来第二个）。\n'
      + '请完全退出知犀（窗口关掉、右下角托盘图标也要退出），然后重新调用我，我会自动带调试端口启动。\n'
      + '或者双击运行 zhixi-mcp\\start-zhixi.cmd 手动启动。',
    );
  }
  throw new Error('已尝试启动知犀客户端，但调试端口仍未就绪。请手动双击 zhixi-mcp\\start-zhixi.cmd 试试。');
}

function isClientRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq zhiximind-desktop.exe" /NH', {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    return out.includes('zhiximind-desktop.exe');
  } catch { return false; }
}

// 极简 CDP 客户端：连接知犀桌面客户端的调试端口
import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

const PORT = Number(process.env.ZHIXI_CDP_PORT || 19222);
const HOST = '127.0.0.1';

function httpJson(path, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: PORT, path, timeout }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('调试端口返回异常: ' + d.slice(0, 100))); }
      });
    });
    req.on('error', (e) => reject(new Error(`连不上知犀客户端调试端口 ${PORT}（${e.code || e.message}）。请先启动客户端并带 --remote-debugging-port=${PORT}`)));
    req.on('timeout', () => req.destroy(new Error('调试端口超时')));
  });
}

export const listTargets = () => httpJson('/json/list');
export const version = () => httpJson('/json/version');

export class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('无法连接页面调试通道')), { once: true });
    });
    const c = new Cdp(ws);
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      const p = m.id && c.pending.get(m.id);
      if (!p) return;
      c.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message || JSON.stringify(m.error))) : p.resolve(m.result);
    });
    return c;
  }

  send(method, params = {}, timeout = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('CDP 调用超时: ' + method));
      }, timeout);
    });
  }

  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw new Error('页面执行出错: ' + d);
    }
    return r.result?.value;
  }

  close() { try { this.ws.close(); } catch {} }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXE = process.env.ZHIXI_EXE || 'C:\\Program Files\\ZhiXi\\ZXMind\\zhiximind-desktop.exe';

// 客户端没跑就拉起来（带调试端口）
export async function ensureClient(waitMs = 30000) {
  try { await version(); return { started: false }; } catch {}
  if (!existsSync(EXE)) {
    throw new Error(`知犀客户端未运行，且找不到程序文件：${EXE}。请手动启动知犀，或用环境变量 ZHIXI_EXE 指定路径。`);
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) delete env[k];
  const child = spawn(EXE, [
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
  ], { cwd: dirname(EXE), env, detached: true, stdio: 'ignore' });
  child.unref();

  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await sleep(1200);
    try { await version(); return { started: true }; } catch {}
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
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq zhiximind-desktop.exe"', { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return out.includes('zhiximind-desktop.exe');
  } catch { return false; }
}

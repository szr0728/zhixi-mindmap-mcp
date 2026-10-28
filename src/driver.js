// 知犀驱动层：通过 CDP 操作运行中的客户端
import { Cdp, listTargets, sleep, ensureClient, activateTarget, parseFileId, getPort, getExePath } from './cdp.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

// 页面侧辅助脚本（幂等注入）
const PAGE_HELPERS = `(() => {
  if (window.__ZX && window.__ZX.__v === 4) return true;
  const protoFns = (o) => { const out = []; let p = o; while (p && p !== Object.prototype) { for (const k of Object.getOwnPropertyNames(p)) { if (k === 'constructor') continue; try { if (typeof o[k] === 'function') out.push(k); } catch (e) {} } p = Object.getPrototypeOf(p); } return [...new Set(out)]; };
  const findMM = () => {
    if (window.__ZX_MM && window.__ZX_MM.store) return window.__ZX_MM;
    const rootEl = document.querySelector('#root,#app,body > div');
    const fk = rootEl && Object.keys(rootEl).find((k) => k.startsWith('__react'));
    let f = fk ? rootEl[fk] : null;
    const stack = [f]; let count = 0;
    while (stack.length && count < 12000) {
      const n = stack.pop(); count++;
      if (!n) continue;
      for (const bag of [n.memoizedState, n.memoizedProps]) {
        const cand = bag && (bag.mindMap || (bag.next && bag.next.mindMap));
        if (cand && cand.store && cand.renderer) { window.__ZX_MM = cand; return cand; }
      }
      if (n.sibling) stack.push(n.sibling);
      if (n.child) stack.push(n.child);
    }
    return null;
  };
  // 把节点的富文本还原成带 $...$ 的文本，公式才能读得回来
  const deltaText = (d) => {
    const rt = d && d.richText;
    if (!rt || !Array.isArray(rt.ops)) return String((d && d.text) || '');
    let s = '';
    rt.ops.forEach((op) => {
      if (typeof op.insert === 'string') s += op.insert;
      else if (op.insert && op.insert.formula) s += '$' + op.insert.formula + '$';
    });
    return s;
  };
  const flat = (node, depth, out, parentId) => {
    const text = deltaText(node.data).replace(/\\n/g, '').trim();
    out.push({ id: node.id, text, depth, parentId: parentId || null });
    const kids = (node.children && node.children.normal) || [];
    kids.forEach((c) => flat(c, depth + 1, out, node.id));
    return out;
  };
  // 完整读：把概要(summary)、外框(boundary)、备注、折叠状态都带上（只用于 read_tree，不影响写操作）
  const flatFull = (node, depth, out, parentId, kind) => {
    if (!node) return out;
    const d = node.data || {};
    const item = {
      id: node.id,
      text: deltaText(d).replace(/\\n/g, '').trim(),
      depth,
      parentId: parentId || null,
    };
    if (kind && kind !== 'normal') item.kind = kind;
    if (d.richText && Array.isArray(d.richText.ops) && d.richText.ops.some((o) => o.insert && o.insert.formula)) {
      item.hasFormula = true;
    }
    if (d.note) item.note = String(d.note).replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 300);
    if (d.todo) item.todo = d.todo;
    if (d.expandState === 'collapse') item.collapsed = true;
    out.push(item);
    const kids = node.children || {};
    ['normal', 'summary', 'boundary'].forEach((k) => {
      (kids[k] || []).forEach((c) => flatFull(c, depth + 1, out, node.id, k));
    });
    return out;
  };
  window.__ZX = {
    __v: 4,
    mm: findMM,
    // 同一个标签页切了别的导图时，缓存的实例会失效。清掉让它重新扫描。
    reset() { window.__ZX_MM = null; return true; },
    tree() { const mm = findMM(); if (!mm || !mm.store) return null; return mm.store.toJson(); },
    nodes() { const t = this.tree(); if (!t || !t.root) return null; return flat(t.root, 0, [], null); },
    fullNodes() { const t = this.tree(); if (!t || !t.root) return null; return flatFull(t.root, 0, [], null, 'normal'); },
    title() { return document.title; },
    resolve(text) {
      const list = this.nodes() || [];
      const norm = (s) => (s || '').replace(/\\s+/g, '');
      const hits = list.filter((n) => norm(n.text) === norm(text));
      return { hits, total: list.length };
    },
    rect(id) {
      const g = document.querySelector('g.zx-node[data-node-id="' + CSS.escape(id) + '"]');
      if (!g) return null;
      const r = g.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    },
    editorBox() {
      const el = document.querySelector('.ql-editor, [contenteditable=true], textarea');
      return el ? { cls: (el.className || '').toString(), text: el.textContent || '' } : null;
    },
    toolbarBtn(label) {
      const cands = [...document.querySelectorAll('div,span,button,a')].filter((el) => {
        if ((el.textContent || '').trim() !== label) return false;
        const r = el.getBoundingClientRect();
        return r.y < 130 && r.width > 10 && r.height > 10 && r.width < 200;
      });
      if (!cands.length) return null;
      cands.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      const r = cands[0].getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    },
  };
  return true;
})()`;

const mapInfo = (e) => ({
  title: (e.title && !/^editor\.html/.test(e.title)) ? e.title : '(标题加载中)',
  fileId: parseFileId(e.url),
});

// 写操作串行化。多个 MCP 调用并发时，它们共享同一个可见窗口和「当前选中节点」，
// 交错执行会点到别的节点上去 —— 这是最危险的一类竞态，直接用队列消除。
let writeChain = Promise.resolve();
function serialize(fn) {
  const run = writeChain.then(fn, fn); // 前一个失败也要继续，不然一次报错会卡死后续所有写入
  writeChain = run.then(() => {}, () => {});
  return run;
}

// hint 可以是 fileId（32 位十六进制，优先按 URL 精确匹配）或标题关键字
async function attachEditor(hint) {
  await ensureClient();
  const targets = await listTargets();
  const editors = targets.filter((t) => (t.url || '').includes('editor.html') && t.type === 'page');
  if (!editors.length) throw new Error('当前没有打开的导图。请先用 zhixi_open_map 打开一张，或在客户端里手动打开。');

  let t = null;
  if (hint) {
    const h = String(hint).trim();
    if (!h) throw new Error('mapId / mapTitle 不能是空字符串');
    const byId = editors.filter((e) => (e.url || '').includes(h));
    if (byId.length === 1) t = byId[0];
    else if (byId.length > 1) {
      // 用短片段匹配到多张时不能猜，宁可报错
      throw new Error(`「${h}」匹配到 ${byId.length} 张已打开的导图，请传完整 fileId：`
        + byId.map((e) => `${mapInfo(e).fileId}(${mapInfo(e).title})`).join('、'));
    }
    if (!t) {
      const byTitle = editors.filter((e) => (e.title || '').includes(h));
      if (byTitle.length === 1) t = byTitle[0];
      else if (byTitle.length > 1) {
        throw new Error(`「${h}」匹配到 ${byTitle.length} 张已打开的导图，请改用 fileId 指定：` + byTitle.map((e) => `${mapInfo(e).fileId}(${mapInfo(e).title})`).join('、'));
      }
    }
    if (!t) {
      throw new Error(`没有找到「${h}」对应的已打开导图。当前打开的有：` + editors.map((e) => `${mapInfo(e).title}[${mapInfo(e).fileId}]`).join('、'));
    }
  } else if (editors.length === 1) {
    t = editors[0];
  } else {
    // 多张图同时打开又没指定 —— 拒绝猜测，避免改错图
    throw new Error(
      `当前同时打开了 ${editors.length} 张导图，必须先指定要改哪一张（传 mapId 或 mapTitle）：\n`
      + editors.map((e) => `- ${mapInfo(e).title}  fileId=${mapInfo(e).fileId}`).join('\n'),
    );
  }

  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable').catch(() => {});
    // 让被遮挡的窗口也保持渲染
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await cdp.eval(PAGE_HELPERS).catch((e) => { throw new Error('注入页面辅助脚本失败：' + e.message); });

    // 刚打开的导图可能还在加载，给几次机会再判定失败
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) {
      ok = !!(await cdp.eval('!!window.__ZX && !!window.__ZX.mm()').catch(() => false));
      if (!ok) await sleep(1200);
    }
    if (!ok) throw new Error('页面已连接，但还没找到导图实例（可能仍在加载，或这张图是空文档）。稍等几秒重试。');
    return { cdp, target: t };
  } catch (e) {
    cdp.close();
    throw e;
  }
}

export async function withEditor(titleHint, fn) {
  const { cdp, target } = await attachEditor(titleHint);
  try { return await fn(cdp, target); } finally { cdp.close(); }
}

export async function status() {
  await ensureClient();
  const targets = await listTargets();
  const editors = targets.filter((t) => (t.url || '').includes('editor.html'));
  const maps = editors.map(mapInfo);

  // 首页在前台时打开导图才可靠，所以把它作为一个诊断项暴露出来
  const home = targets.find((t) => (t.url || '').includes('home.html'));
  let homeVisible = null;
  if (home) {
    try {
      const c = await Cdp.connect(home.webSocketDebuggerUrl);
      homeVisible = (await c.eval('document.visibilityState')) === 'visible';
      c.close();
    } catch { homeVisible = null; }
  }

  return {
    editors: maps,
    hasHome: !!home,
    homeVisible,
    needSpecify: maps.length > 1,
    port: getPort(),
    exe: getExePath(),
    exeExists: existsSync(getExePath()),
  };
}

// 注意：绝对不要发 mouseMoved。编辑器页面上一次 mouseMoved 会阻塞约 5 秒
// （窗口被遮挡时等不到帧确认），而我们只按坐标点击、不依赖 hover 状态。
async function click(cdp, x, y, doubleClick = false) {
  const counts = doubleClick ? [1, 2] : [1];
  for (const cc of counts) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: cc });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: cc });
    await sleep(90);
  }
}

async function keyPress(cdp, key, code, vk, modifiers = 0) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
}

// 等编辑器回到「已保存」状态，确认改动真的落盘了（而不是只改了内存）
async function waitSaved(cdp, timeout = 8000) {
  const readState = `(() => {
    const t = document.body.innerText || '';
    if (/保存中|同步中/.test(t)) return 'saving';
    if (/已保存|保存成功/.test(t)) return 'saved';
    return 'unknown';
  })()`;
  await sleep(700); // 给 UI 一点时间切到「保存中」，否则会误判成已保存
  const t0 = Date.now();
  let sawSaving = false;
  while (Date.now() - t0 < timeout) {
    const st = await cdp.eval(readState).catch(() => 'unknown');
    if (st === 'saving') sawSaving = true;
    if (st === 'saved' && sawSaving) return { saved: true, ms: Date.now() - t0 };
    if (st === 'saved' && !sawSaving && Date.now() - t0 > 2500) return { saved: true, ms: Date.now() - t0, note: '未观察到保存中状态（改动可能极快完成）' };
    await sleep(400);
  }
  return { saved: false, ms: Date.now() - t0 };
}

// 保证节点坐标真的可点：用 elementFromPoint 直接确认那个点上是不是目标节点。
// 只判断坐标范围不够 —— 节点可能一半在视口外（中心在界内但实际被裁剪），
// 此时点击会打空甚至命中旁边的节点，导致改错。
const PROBE_FN = (id) => `(() => {
  const id = ${JSON.stringify(id)};
  const r = window.__ZX.rect(id);
  if (!r) return { rect: null, ok: false, why: 'no-rect' };
  const el = document.elementFromPoint(r.x, r.y);
  const owner = el && el.closest ? el.closest('g.zx-node') : null;
  const hit = owner ? owner.getAttribute('data-node-id') : (el ? el.tagName : 'none');
  return { rect: r, ok: hit === id, why: hit === id ? 'ok' : 'hit:' + hit };
})()`;

// 把节点挪到视口中间，代价是画布会平移（用户能看到跳一下），所以只在必要时调用
async function centerNode(cdp, id) {
  return cdp.eval(`(() => {
    const mm = window.__ZX.mm(); const id = ${JSON.stringify(id)};
    try {
      if (mm && mm.renderer && mm.renderer.moveNodeToViewCenter) mm.renderer.moveNodeToViewCenter(id);
      else if (mm && mm.moveNodeToViewCenter) mm.moveNodeToViewCenter(id);
      else return 'no-api';
    } catch (e) { return 'err'; }
    return 'ok';
  })()`).catch(() => null);
}

async function ensureClickable(cdp, id) {
  let st = await cdp.eval(PROBE_FN(id)).catch(() => null);
  if (!st) throw new Error('探测节点位置时页面无响应，请重试：' + id);
  if (st.ok) return st.rect;

  // 拿不到 DOM 位置时，可能是缓存了旧导图的实例（同一标签页切了别的图），清掉重新扫描
  if (st.why === 'no-rect') {
    await cdp.eval('window.__ZX.reset && window.__ZX.reset()').catch(() => {});
    await sleep(300);
    const again = await cdp.eval(PROBE_FN(id)).catch(() => null);
    if (again && again.ok) return again.rect;
    if (again) st = again;
  }

  for (let attempt = 0; attempt < 3 && !st.ok; attempt++) {
    await centerNode(cdp, id);
    await sleep(attempt === 0 ? 800 : 1200);
    const next = await cdp.eval(PROBE_FN(id)).catch(() => null);
    if (!next) break;
    st = next;
  }
  if (!st.ok) {
    const where = st.rect ? `坐标 ${st.rect.x},${st.rect.y}` : '拿不到坐标';
    throw new Error(`节点无法定位到可点击位置（${where}，${st.why}），为避免改错节点已中止。nodeId=${id}`);
  }
  return st.rect;
}

async function selectNode(cdp, id) {
  const rect = await ensureClickable(cdp, id);
  await click(cdp, rect.x, rect.y);
  await sleep(250);

  // 校验：点击后必须能在选中态里看到目标节点，否则宁可报错也不继续
  const rawSel = await cdp.eval(
    'JSON.stringify([...document.querySelectorAll("g.zx-node.selected")].map(g => g.getAttribute("data-node-id")))',
  ).catch(() => '[]');
  let selIds = [];
  try { selIds = JSON.parse(rawSel || '[]'); } catch { selIds = []; }
  if (!Array.isArray(selIds)) selIds = [];
  if (!selIds.includes(id)) {
    throw new Error(`点击未能选中目标节点（实际选中: ${selIds.length ? selIds.join(',') : '无'}），为避免改错节点已中止。nodeId=${id}`);
  }
}

// 把带 $...$ 的文本转成 Quill Delta。$...$ 里是 LaTeX，会被渲染成真正的数学公式。
// 例：'圆方程：$x^2+y^2=r^2$' ->
//    [{insert:'圆方程：'}, {insert:{formula:'x^2+y^2=r^2'}}, {insert:'\n'}]
export function textToDelta(text) {
  // 支持用 \$ 表示字面美元号，否则「价格 $5 和 $6」会被误判成公式
  const ESC = '\u0001';
  const s = String(text == null ? '' : text).replace(/\\\$/g, ESC);
  const ops = [];
  const re = /\$([^$\n]+)\$/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) ops.push({ insert: s.slice(last, m.index) });
    ops.push({ insert: { formula: m[1] } });
    last = m.index + m[0].length;
  }
  const tail = s.slice(last);
  if (tail) ops.push({ insert: tail });
  // 把占位符还原成真正的美元号
  for (const op of ops) {
    if (typeof op.insert === 'string' && op.insert.includes(ESC)) {
      op.insert = op.insert.split(ESC).join('$');
    }
  }

  // 合并相邻的字符串 op
  const merged = [];
  for (const op of ops) {
    const prev = merged[merged.length - 1];
    if (prev && typeof prev.insert === 'string' && typeof op.insert === 'string') prev.insert += op.insert;
    else merged.push(op);
  }
  if (!merged.length) merged.push({ insert: '' });
  const lastOp = merged[merged.length - 1];
  if (typeof lastOp.insert === 'string') {
    if (!lastOp.insert.endsWith('\n')) lastOp.insert += '\n';
  } else {
    merged.push({ insert: '\n' });
  }
  return { ops: merged };
}

// 写入节点文本。必须走 Quill API 并传 source='user'：
//   默认的 'api' source 会被编辑器忽略，改动不会落到节点上。
// 用 setContents 而不是模拟键盘输入，才能把公式作为 embed 精确插进去。
async function typeIntoEditor(cdp, text, fast = false) {
  const ready = await cdp.eval(
    '!!(document.querySelector(".ql-container") && document.querySelector(".ql-container").__quill)',
  );
  if (!ready) throw new Error('没有进入文本编辑状态（节点可能没被双击选中，或编辑器还没渲染完）');
  const delta = JSON.stringify(textToDelta(text));
  const raw = await cdp.eval(`(() => {
    const q = document.querySelector('.ql-container').__quill;
    try { q.setContents(${delta}, 'user'); return JSON.stringify({ ok: true, len: q.getLength() }); }
    catch (e) { return JSON.stringify({ ok: false, err: String(e && e.message || e).slice(0, 160) }); }
  })()`);
  let res;
  try { res = JSON.parse(raw); } catch { throw new Error('写入文本时页面返回了非预期结果: ' + String(raw).slice(0, 120)); }
  if (!res || !res.ok) throw new Error('写入文本失败：' + ((res && res.err) || '未知原因'));
  await sleep(fast ? 110 : 250);
  await keyPress(cdp, 'Escape', 'Escape', 27);
  await sleep(fast ? 270 : 600);
}

// 页面返回 null 说明导图还没就绪，这里统一转成可读错误，避免下游出现 "Cannot read properties of null"
async function getNodes(cdp) {
  const n = await cdp.eval('window.__ZX.nodes()');
  if (!Array.isArray(n)) throw new Error('读不到节点树（导图可能还在加载，或页面已切走）。稍等几秒重试。');
  return n;
}

// 比对文字时忽略空白差异，避免因换行/空格被判成失败
const normText = (s) => String(s == null ? '' : s).replace(/\s+/g, '');

export async function readTree(titleHint, { limit = 400 } = {}) {
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 400;
  return withEditor(titleHint, async (cdp, target) => {
    const title = await cdp.eval('window.__ZX.title()');
    const all = await cdp.eval('window.__ZX.fullNodes()');
    if (!Array.isArray(all)) throw new Error('读不到节点树（导图可能还在加载）。稍等几秒重试。');
    const stats = {
      total: all.length,
      summary: all.filter((n) => n.kind === 'summary').length,
      boundary: all.filter((n) => n.kind === 'boundary').length,
      withNote: all.filter((n) => n.note).length,
      withFormula: all.filter((n) => n.hasFormula).length,
      collapsed: all.filter((n) => n.collapsed).length,
    };
    // 大图一次全吐出来会把调用方的上下文撑爆，超过上限就截断并明确告知
    const nodes = all.slice(0, max);
    const out = { mapTitle: title, id: parseFileId(target.url), count: all.length, stats, nodes };
    if (nodes.length < all.length) {
      out.truncated = true;
      out.returned = nodes.length;
      out.note = `节点太多，只返回前 ${nodes.length} 个（共 ${all.length}）。可以用 nodeId 精确定位，或调大 limit。`;
    }
    return out;
  });
}

async function resolveId(cdp, { nodeId, text }) {
  // 给了 nodeId 就先校验它确实在当前导图里 —— 否则后续会以"点不中节点"这种费解的方式失败
  if (nodeId && String(nodeId).trim()) {
    const id = String(nodeId).trim();
    const nodes = await getNodes(cdp);
    if (!nodes.some((n) => n.id === id)) {
      throw new Error(`nodeId=${id} 不在当前导图里（可能来自别的图，或该节点已被删除）。请先调用 zhixi_read_tree 重新获取。`);
    }
    return id;
  }
  if (!text || !String(text).trim()) throw new Error('需要提供 nodeId 或 text');
  const r = await cdp.eval(`(() => { const x = window.__ZX.resolve(${JSON.stringify(text)}); return { hits: x.hits.map(n => ({ id: n.id, text: n.text, depth: n.depth })), total: x.total }; })()`);
  if (!r || !Array.isArray(r.hits)) throw new Error('按文字定位节点时页面返回异常，请改用 nodeId');
  if (!r.hits.length) throw new Error(`没有文字为「${text}」的节点。可以先调用 zhixi_read_tree 看看有哪些节点。`);
  if (r.hits.length > 1) throw new Error(`「${text}」匹配到 ${r.hits.length} 个节点，请改用 nodeId：` + r.hits.map((h) => `${h.id}(${h.text})`).join(', '));
  return r.hits[0].id;
}

// 批量新增同级子节点：第一个用「子主题」，其余用「主题」（同级），省掉反复选中父节点的开销
export async function addNodes({ parentId, parentText, texts }, titleHint) {
  const list = (Array.isArray(texts) ? texts : []).map((t) => String(t == null ? '' : t).trim()).filter((t) => t);
  if (!list.length) throw new Error('texts 需要是非空的文字数组');
  if (list.length > 60) throw new Error('一次不要超过 60 个节点，分批调用更稳');
  return serialize(() => withEditor(titleHint, async (cdp) => {
    const pid = await resolveId(cdp, { nodeId: parentId, text: parentText });
    await selectNode(cdp, pid);
    const t0 = Date.now();
    const done = [];
    try {
      for (let i = 0; i < list.length; i++) {
        const label = i === 0 ? '子主题' : '主题';
        const btn = await cdp.eval(`window.__ZX.toolbarBtn(${JSON.stringify(label)})`);
        if (!btn) throw new Error(`工具栏没找到「${label}」按钮`);
        await click(cdp, btn.x, btn.y);
        await sleep(600);
        await typeIntoEditor(cdp, list[i], true);
        done.push(i);
      }
    } catch (e) {
      // 中途失败时把已经加成功的报出来，避免调用方不知道图里多了什么
      const rest = list.filter((_, i) => !done.includes(i));
      const err = new Error(
        `批量新增在第 ${done.length + 1} 个失败：${e.message}\n`
        + `已成功添加 ${done.length} 个：${done.map((i) => list[i]).join('、') || '（无）'}\n`
        + `未添加 ${rest.length} 个：${rest.join('、') || '（无）'}`,
      );
      err.partial = { added: done.map((i) => list[i]), failed: rest };
      throw err;
    }
    const nodes = await getNodes(cdp);
    const kids = nodes.filter((n) => n.parentId === pid).map((n) => ({ id: n.id, text: n.text }));
    const sync = await waitSaved(cdp);
    const ms = Date.now() - t0;
    return {
      ok: true,
      parentId: pid,
      added: list.length,
      ms,
      perNodeMs: Math.round(ms / list.length),
      children: kids,
      total: nodes.length,
      synced: sync.saved,
      ...(sync.saved ? {} : { warning: '编辑器还没回到「已保存」状态，等几秒再用 zhixi_verify_synced 确认落盘' }),
    };
  }));
}

export async function addNode({ parentId, parentText, text }, titleHint) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) throw new Error('节点文字不能为空');
  return serialize(() => withEditor(titleHint, async (cdp) => {
    const pid = await resolveId(cdp, { nodeId: parentId, text: parentText });
    const beforeIds = new Set((await getNodes(cdp)).map((n) => n.id));
    await selectNode(cdp, pid);
    const btn = await cdp.eval(`window.__ZX.toolbarBtn('子主题')`);
    if (!btn) throw new Error('工具栏没找到「子主题」按钮');
    await click(cdp, btn.x, btn.y);
    await sleep(800);
    await typeIntoEditor(cdp, t);
    const nodes = await getNodes(cdp);
    // 按「新增的 id」判断，不用文字比对（公式会被还原成 $...$，比对容易失配）
    const created = nodes.filter((n) => n.parentId === pid && !beforeIds.has(n.id));
    const sync = await waitSaved(cdp);
    if (!created.length) {
      throw new Error('点了「子主题」也输入了文字，但没有出现新节点。可能编辑态被中断，请重试；若反复失败，手动看一眼客户端。');
    }
    return {
      ok: true, parentId: pid, created: created[0] || null, count: nodes.length, synced: sync.saved,
      ...(sync.saved ? {} : { warning: '编辑器还没回到「已保存」状态，等几秒再用 zhixi_verify_synced 确认落盘' }),
    };
  }));
}

export async function updateNode({ nodeId, text, newText }, titleHint) {
  const finalText = String(newText ?? text ?? '');
  if (!finalText.trim()) throw new Error('新文字不能为空（清空内容请用 zhixi_delete_node）');
  return serialize(() => withEditor(titleHint, async (cdp) => {
    const id = await resolveId(cdp, { nodeId, text });
    const rect = await ensureClickable(cdp, id);
    await click(cdp, rect.x, rect.y, true);
    await sleep(700);
    await typeIntoEditor(cdp, finalText);
    const nodes = await getNodes(cdp);
    const n = nodes.find((x) => x.id === id);
    const sync = await waitSaved(cdp);
    // 写完必须校对：改到别的节点、或被云端回滚，都应该明确报错而不是假装成功
    const actual = n ? n.text : '';
    if (normText(actual) !== normText(finalText)) {
      throw new Error(
        `文字写入后校对不一致。\n期望：${finalText}\n实际：${actual || '（节点已找不到）'}\n`
        + '可能是编辑器还在提交或该节点被并发修改，请先用 zhixi_read_tree 确认当前内容再重试。',
      );
    }
    return { ok: true, nodeId: id, text: actual, verified: true, synced: sync.saved };
  }));
}

export async function deleteNode({ nodeId, text, confirm }, titleHint) {
  if (!confirm) throw new Error('删除是破坏性操作：请先调用 zhixi_read_tree 确认节点，然后传 confirm=true 再执行。');
  return serialize(() => withEditor(titleHint, async (cdp) => {
    const id = await resolveId(cdp, { nodeId, text });
    const before = await getNodes(cdp);
    const target = before.find((n) => n.id === id);
    if (!target) throw new Error('节点不存在: ' + id);
    const subtree = collectSubtree(before, id);
    await selectNode(cdp, id);
    await keyPress(cdp, 'Delete', 'Delete', 46);
    await sleep(900);
    const after = await getNodes(cdp);
    const sync = await waitSaved(cdp);
    // 必须确认真的删掉了：选中态丢失时 Delete 键会被页面吞掉，不校验就会误报成功
    if (after.some((n) => n.id === id)) {
      throw new Error(
        `按了 Delete 但节点还在（选中态可能被中断，未删除任何内容）。`
        + `节点「${target.text}」nodeId=${id}。请重试。`,
      );
    }
    const expectedLeft = before.length - subtree.length;
    return {
      ok: true,
      deleted: { id, text: target.text, subtree },
      remaining: after.length,
      subtreeCount: subtree.length,
      // 少太多说明可能连带删了别的东西，报出来让人核对
      ...(after.length === expectedLeft ? {} : { warning: `删除前 ${before.length} 个节点，删掉 ${subtree.length} 个子树节点，现在 ${after.length} 个，与预期 ${expectedLeft} 不一致，请核对` }),
      synced: sync.saved,
    };
  }));
}

function collectSubtree(nodes, id) {
  const out = [];
  const walk = (nid, d) => {
    const n = nodes.find((x) => x.id === nid);
    if (!n) return;
    out.push({ id: n.id, text: n.text, depth: d });
    nodes.filter((x) => x.parentId === nid).forEach((c) => walk(c.id, d + 1));
  };
  walk(id, 0);
  return out;
}

export async function moveNode({ nodeId, text, targetParentId, targetParentText }, titleHint) {
  return serialize(() => withEditor(titleHint, async (cdp) => {
    const id = await resolveId(cdp, { nodeId, text });
    const tid = await resolveId(cdp, { nodeId: targetParentId, text: targetParentText });
    const before = await getNodes(cdp);
    const moved = before.find((n) => n.id === id);
    const target = before.find((n) => n.id === tid);
    if (!moved) throw new Error('要移动的节点不存在: ' + id);
    if (!target) throw new Error('目标父节点不存在: ' + tid);
    if (id === tid) throw new Error('不能移动到自身下面');
    // 目标在自己子树里会造成环，这种移动必须拦下来
    const subIds = new Set(collectSubtree(before, id).map((n) => n.id));
    if (subIds.has(tid)) throw new Error(`目标节点「${target.text}」在被移动节点自己的子树里，这样的移动不合法。`);

    await selectNode(cdp, id);
    await keyPress(cdp, 'x', 'KeyX', 88, 2); // Ctrl+X
    await sleep(700);

    // 剪切后节点已经在剪贴板里，粘贴失败就等于节点"悬空"。
    // 所以这里必须重试，并把最终状态如实报出来，不能含糊地说"未成功"。
    const beforeIds = new Set(before.map((n) => n.id));
    let after = null;
    let now = null;
    for (let attempt = 0; attempt < 2 && !now; attempt++) {
      await selectNode(cdp, tid);
      await keyPress(cdp, 'v', 'KeyV', 86, 2); // Ctrl+V
      await sleep(1400);
      after = await getNodes(cdp);
      // 粘贴通常会生成新 id，所以按「父节点是目标 + 文字相同 + id 是新的」来认
      const cands = after.filter((n) => n.parentId === tid && n.text === moved.text);
      now = cands.find((n) => !beforeIds.has(n.id)) || cands.find((n) => n.id === id) || null;
    }
    if (!now) {
      throw new Error(
        `移动未完成：节点「${moved.text}」已经剪切，但没能粘贴到「${target.text}」下面。\n`
        + `请重试 zhixi_move_node，或立刻在客户端里选中「${target.text}」按 Ctrl+V 粘回去。`,
      );
    }
    const sync = await waitSaved(cdp);
    return {
      ok: true, moved: moved.text, from: moved.parentId, to: tid, toText: target.text,
      newId: now.id, count: after.length, synced: sync.saved,
    };
  }));
}

// 直接从云端取导图文件内容，验证"真的同步上去了"（不是只改了本地内存）
export async function cloudCheck({ fileId, mapId, contains }) {
  const id = fileId || mapId;
  if (!id) throw new Error('需要提供 mapId（即导图 fileId）');
  const cdp = await attachHome();
  let meta;
  try {
    meta = await cdp.eval(`(async () => {
      try {
        const res = await window.__runtime.invoke('fs:open-file', { fileId: ${JSON.stringify(id)}, password: '' });
        if (!res || !res.data) return { err: 'code=' + (res && res.code) };
        return { title: res.data.title, url: res.data.content };
      } catch (e) { return { err: String(e && e.message || e).slice(0, 160) }; }
    })()`);
  } finally { cdp.close(); }
  if (!meta || !meta.url) throw new Error('取不到云端文件地址：' + ((meta && meta.err) || '未知错误'));

  let text;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(meta.url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    text = await res.text();
  } catch (e) {
    throw new Error(`下载云端文件失败：${e.message}（网络问题可稍后重试；文件本身大概率没问题）`);
  }

  const hit = contains ? text.includes(contains) : null;
  return {
    title: meta.title,
    bytes: text.length,
    checked: contains || null,
    contains: hit,
    note: contains
      ? (hit ? '云端文件里已包含该文字，说明改动真的落盘了' : '云端文件里没有找到这段文字，可能还在同步，隔几秒再试一次')
      : '仅确认文件可读取',
  };
}

export async function screenshot(titleHint, outPath) {
  return withEditor(titleHint, async (cdp, target) => {
    // 后台标签页的 visibilityState 是 hidden，captureScreenshot 会一直等帧直到超时。
    // 只有真的 hidden 才去切前台 —— 无谓地激活标签页会打乱用户正在看的页面。
    let vis = await cdp.eval('document.visibilityState').catch(() => 'unknown');
    let activated = false;
    if (vis === 'hidden') {
      try { await activateTarget(target.id); activated = true; } catch { /* 切不过去也继续试 */ }
      await sleep(1200);
      vis = await cdp.eval('document.visibilityState').catch(() => 'unknown');
    }
    let shot;
    try {
      shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    } catch (e) {
      throw new Error(`截图超时（页面可见性=${vis}）。这张图在后台标签页时 Chromium 不出帧，先在知犀里点一下它的标签页再试。`);
    }
    if (!shot || !shot.data) throw new Error('截图返回空数据');
    let abs = null;
    if (outPath) {
      abs = resolvePath(String(outPath));
      // 目录不存在就直接写会抛 ENOENT，先补出来
      try {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, Buffer.from(shot.data, 'base64'));
      } catch (e) {
        throw new Error(`截图成功但保存失败（${abs}）：${e.message}。可以把 savePath 换到有写权限的目录。`);
      }
    }
    return {
      base64: shot.data,
      bytes: Math.round(shot.data.length * 0.75),
      path: abs,
      visibility: vis,
      ...(activated ? { note: '这张图原来在后台标签页，为了出帧已把它切到前台' } : {}),
    };
  });
}

// 首页内的 IPC 调用（返回解析后的结果）
async function homeInvoke(cdp, channel, arg) {
  const r = await cdp.eval(`(async () => {
    try {
      const res = await window.__runtime.invoke(${JSON.stringify(channel)}, ${JSON.stringify(arg || {})});
      return { ok: true, res };
    } catch (e) { return { ok: false, err: String(e && e.message || e).slice(0, 200) }; }
  })()`);
  if (!r.ok) throw new Error(`调用 ${channel} 失败：${r.err}`);
  const res = r.res;
  const code = res && res.code;
  if (code !== undefined && code !== null && Number(code) !== 0) {
    throw new Error(`${channel} 返回错误 code=${code}` + (res.message ? `：${res.message}` : ''));
  }
  return res && 'data' in res ? res.data : res;
}

// 把「路径 / 标题 / fileId」解析成树里的节点
async function resolveItem(cdp, { fileId, path, title, wantFolder = null }) {
  const all = flattenTree(await fetchTree(cdp));
  const norm = (s) => (s || '').replace(/\s+/g, '').toLowerCase();
  const pool = wantFolder === null ? all : all.filter((it) => it.isFolder === wantFolder);

  if (fileId) {
    const hit = pool.find((it) => it.fileId === fileId);
    if (hit) return hit;
    // 要的是文件夹却找不到时不能退回 stub —— 调用方会拿到 id=null 然后默默建到根目录
    if (wantFolder) throw new Error(`fileId=${fileId} 不是文件夹，或该文件夹已不在当前目录里。可以先用 zhixi_list_maps 核对。`);
    return { fileId, title: title || '', id: null, path: null, isFolder: false };
  }
  if (path) {
    const hit = pool.filter((it) => norm(it.path) === norm(String(path).replace(/^\/+|\/+$/g, '')));
    if (hit.length === 1) return hit[0];
    if (hit.length > 1) throw new Error(`路径「${path}」匹配到 ${hit.length} 项，请用 fileId 指定：` + hit.map((h) => `${h.fileId}(${h.title})`).join('、'));
    const guess = pool.filter((it) => norm(it.path).includes(norm(path))).map((it) => it.path);
    throw new Error(`没找到路径「${path}」。` + (guess.length ? `相近的有：${guess.slice(0, 6).join('、')}` : ''));
  }
  if (title) {
    const hit = pool.filter((it) => norm(it.title) === norm(title));
    if (hit.length === 1) return hit[0];
    if (hit.length > 1) throw new Error(`有 ${hit.length} 项都叫「${title}」，请用 path 或 fileId：` + hit.map((h) => h.path).join('、'));
    const guess = pool.filter((it) => norm(it.title).includes(norm(title))).map((it) => it.path);
    throw new Error(`没找到标题为「${title}」的条目。` + (guess.length ? `相近的有：${guess.slice(0, 6).join('、')}` : ''));
  }
  throw new Error('需要提供 path / title / fileId 之一');
}

const ROOT_PID = 0;

// 解析目标文件夹 → parentId。空路径等于根目录；给了路径却解析不出 id 时直接报错，
// 绝不静默退回根目录（否则"建在指定文件夹"会变成"建在根目录"这种静默错误）。
async function folderPid(cdp, folderPath) {
  const p = String(folderPath || '').trim();
  if (!p) return ROOT_PID;
  const parent = await resolveItem(cdp, { path: p, wantFolder: true });
  const pid = parent && parent.id;
  if (pid === null || pid === undefined) {
    throw new Error(`找不到文件夹「${p}」，请先用 zhixi_list_maps 确认完整路径。`);
  }
  return pid;
}

export async function createFolder({ title, folder, parentPath }) {
  const name = String(title == null ? '' : title).trim();
  if (!name) throw new Error('文件夹名不能为空');
  const cdp = await attachHome();
  try {
    const pid = await folderPid(cdp, parentPath || folder);
    const fileId = await homeInvoke(cdp, 'fs:create-folder', { title: name, pid, password: '' });
    if (!fileId) throw new Error('接口没有返回新文件夹的 fileId，创建可能没生效，请到客户端确认一眼');
    await sleep(1200);
    const all = flattenTree(await fetchTree(cdp));
    const created = all.find((it) => it.fileId === fileId) || null;
    return { ok: true, title: name, fileId, path: created ? created.path : null, parentId: pid };
  } finally { cdp.close(); }
}

// 新建导图：直接调主进程的 fs:create-file 接口建档，不再模拟点击界面。
// 之前走 UI 点「新建 → 思维导图」会被侧边栏的悬浮提示抢掉点击，且模板卡片是 hover 触发的，
// 版本一改就点不动 —— 接口方式只依赖一个稳定的 channel，参数也已经被实测确认。
export function createMap({ title, folder, parentPath, structure = 'none', open = true }) {
  return serialize(async () => {
    const cdp = await attachHome();
    try {
      const pid = await folderPid(cdp, parentPath || folder);
      const res = await homeInvoke(cdp, 'fs:create-file', {
        data: { type: 'structure', structure: String(structure || 'none'), trackFrom: 'zhixi-mcp' },
        pid,
      });
      const fileId = res && res.fileId;
      if (!fileId) throw new Error('新建接口没有返回 fileId，创建可能没成功（返回: ' + JSON.stringify(res).slice(0, 120) + '）');

      const name = String(title == null ? '' : title).trim();
      if (name) await homeInvoke(cdp, 'fs:rename-file', { title: name, fileId, password: '' });
      if (pid !== ROOT_PID) await homeInvoke(cdp, 'fs:move-files', { dest: pid, fileIds: [fileId], password: '' });
      await sleep(1200);

      const all = flattenTree(await fetchTree(cdp));
      const created = all.find((it) => it.fileId === fileId) || null;

      // 顺手打开它，方便紧接着写节点；打不开不算失败
      let openErr = null;
      if (open) {
        const o = await openByFileId(cdp, { fileId, title: name || (created && created.title) || '' });
        if (!o.target) openErr = o.err || '未知';
      }

      return {
        ok: true,
        fileId,
        title: name || (created && created.title) || '(未命名)',
        path: created ? created.path : null,
        opened: open ? !openErr : false,
        ...(openErr ? { warning: '导图已创建，但自动打开失败（' + openErr + '）。可以用 zhixi_open_map 再打开。' } : {}),
        ...(created ? {} : { warning: '新导图已创建，但目录树里暂时看不到（可能还在同步）。稍后用 zhixi_list_maps 核对。' }),
      };
    } finally { cdp.close(); }
  });
}

export async function renameItem({ fileId, path, title, newTitle }) {
  if (!newTitle || !String(newTitle).trim()) throw new Error('新名称不能为空');
  const cdp = await attachHome();
  try {
    const item = await resolveItem(cdp, { fileId, path, title });
    await homeInvoke(cdp, 'fs:rename-file', { title: String(newTitle).trim(), fileId: item.fileId, password: '' });
    await sleep(1200);
    const all = flattenTree(await fetchTree(cdp));
    const now = all.find((it) => it.fileId === item.fileId);
    return { ok: true, fileId: item.fileId, oldTitle: item.title, newTitle: String(newTitle).trim(), path: now ? now.path : null };
  } finally { cdp.close(); }
}

export async function moveItems({ fileId, path, title, toFolder, toPath }) {
  const cdp = await attachHome();
  try {
    const item = await resolveItem(cdp, { fileId, path, title });
    if (!item.fileId) throw new Error('解析不到要移动条目的 fileId，请改用 fileId 直接指定');
    const dest = await folderPid(cdp, toPath || toFolder);
    const all0 = flattenTree(await fetchTree(cdp));
    const destNode = all0.find((it) => it.id === dest);
    const destPath = destNode ? destNode.path : '';

    // 把文件夹移进自己或自己的子孙里会造成循环，知犀不一定拦，这里必须前置拦截
    if (dest !== ROOT_PID) {
      if (item.isFolder && destPath && (destPath === item.path || destPath.startsWith(item.path + '/'))) {
        throw new Error(`不能把文件夹「${item.path}」移动到它自己或它的子目录「${destPath}」里。`);
      }
      if (destNode && destNode.fileId === item.fileId) {
        throw new Error('目标文件夹就是它自己，不需要移动。');
      }
    }

    await homeInvoke(cdp, 'fs:move-files', { dest, fileIds: [item.fileId], password: '' });
    await sleep(1500);
    const all = flattenTree(await fetchTree(cdp));
    const now = all.find((it) => it.fileId === item.fileId);
    if (!now) {
      throw new Error('移动接口已执行，但结算时在目录树里找不到这个条目了。请在客户端确认一下（大概率只是列表还没刷新）。');
    }
    return { ok: true, fileId: item.fileId, title: item.title, to: destPath || '(根目录)', path: now.path };
  } finally { cdp.close(); }
}

export async function deleteItem({ fileId, path, title, confirm }) {
  const cdp = await attachHome();
  try {
    const item = await resolveItem(cdp, { fileId, path, title });
    if (!item.fileId) throw new Error('解析不到要删除条目的 fileId，请改用 fileId 直接指定');

    // 没确认时不是直接报错，而是把将被删除的东西（含子项数量）报回去，让调用方能安全地二次确认
    if (!confirm) {
      const all0 = flattenTree(await fetchTree(cdp));
      const desc = item.isFolder
        ? all0.filter((it) => it.path.startsWith(item.path + '/'))
        : [];
      return {
        ok: false,
        needConfirm: true,
        target: { title: item.title, path: item.path, isFolder: item.isFolder, fileId: item.fileId },
        ...(item.isFolder ? { descendantCount: desc.length, descendants: desc.slice(0, 20).map((d) => d.path) } : {}),
        note: '这是破坏性操作（会连同子项一起移入知犀回收站）。确认无误后带 confirm=true 再调用一次。',
      };
    }

    await homeInvoke(cdp, 'fs:mark-file-deleted', { fileIds: [item.fileId], password: '' });
    await sleep(1500);
    const all = flattenTree(await fetchTree(cdp));
    const stillThere = all.some((it) => it.fileId === item.fileId);
    return {
      ok: !stillThere,
      deleted: { title: item.title, path: item.path, isFolder: item.isFolder, fileId: item.fileId },
      note: stillThere ? '接口返回成功但目录里还能看到，可能尚未刷新，请稍后复查' : '已移入回收站，可在知犀客户端还原',
    };
  } finally { cdp.close(); }
}

export async function searchMaps({ keyword }) {
  if (!keyword || !String(keyword).trim()) throw new Error('请提供搜索关键字');
  const cdp = await attachHome();
  try {
    const all = flattenTree(await fetchTree(cdp));
    const norm = (s) => (s || '').replace(/\s+/g, '').toLowerCase();
    const k = norm(keyword);
    const hits = all.filter((it) => !it.isFolder && norm(it.title).includes(k));
    return { keyword, count: hits.length, matches: hits.slice(0, 50).map((h) => ({ path: h.path, title: h.title, fileId: h.fileId })) };
  } finally { cdp.close(); }
}

// 首页：列出/打开云文档
async function attachHome() {
  await ensureClient();
  let home = null;
  for (let i = 0; i < 15; i++) {
    const targets = await listTargets();
    home = targets.find((t) => (t.url || '').includes('home.html'));
    if (home) break;
    await sleep(1000);
  }
  if (!home) throw new Error('首页窗口不存在（客户端可能只开了编辑器）');
  const cdp = await Cdp.connect(home.webSocketDebuggerUrl);
  await cdp.send('Page.enable').catch(() => {});
  await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  // 等首页把文件列表渲染出来
  for (let i = 0; i < 20; i++) {
    const ready = await cdp.eval(`document.querySelectorAll('[class*=card_title]').length > 0 || document.body.innerText.length > 300`).catch(() => false);
    if (ready) break;
    await sleep(800);
  }
  return cdp;
}

// 通过主进程 IPC 拉取完整云文档树（含文件夹层级）
async function fetchTree(cdp) {
  const raw = await cdp.eval(`(async () => {
    try {
      return await window.__runtime.invoke('fs:query-file-tree', { recursive: true, includeFiles: true });
    } catch (e) { return { code: -1, message: String(e && e.message || e) }; }
  })()`);
  if (!raw || raw.code === undefined || Number(raw.code) !== 0) {
    throw new Error('获取云文档目录失败：' + JSON.stringify(raw).slice(0, 160)
      + '（如果反复失败，可能是客户端还没登录或首页没加载完，稍等几秒重试）');
  }
  return Array.isArray(raw.data) ? raw.data : [];
}

// 把嵌套树拍平成带完整路径的列表；type 0 = 文件夹，1 = 导图文件
function flattenTree(nodes, parentPath = '') {
  const out = [];
  for (const n of nodes) {
    if (!n) continue;
    const isFolder = Number(n.type) === 0; // 接口有时给字符串 "0"，直接 === 0 会漏判
    const title = String(n.title || '').trim() || '(未命名)';
    const path = parentPath ? `${parentPath}/${title}` : title;
    out.push({
      path,
      title,
      isFolder,
      fileId: n.fileId || null,
      id: n.id,
      updatedAt: n.updatedAt || null,
    });
    if (isFolder && Array.isArray(n.children) && n.children.length) {
      out.push(...flattenTree(n.children, path));
    }
  }
  return out;
}

function treeText(items) {
  return items
    .map((it) => '  '.repeat(it.path.split('/').length - 1) + (it.isFolder ? '📁 ' : '📄 ') + it.title)
    .join('\n');
}

export async function listMaps({ folder, includeFiles = true } = {}) {
  const cdp = await attachHome();
  try {
    const all = flattenTree(await fetchTree(cdp));
    let scoped = all;
    let scopePath = null;
    if (folder && String(folder).trim()) {
      const q = String(folder).trim().replace(/^\/+|\/+$/g, '');
      const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
      const hit = all.find((it) => it.isFolder && (norm(it.path) === norm(q) || norm(it.title) === norm(q)));
      if (!hit) {
        const guess = all.filter((it) => it.isFolder && norm(it.path).includes(norm(q))).map((it) => it.path);
        throw new Error(`没有找到文件夹「${folder}」。` + (guess.length ? `相近的有：${guess.slice(0, 8).join('、')}` : '可以先不带 folder 参数看全部分录。'));
      }
      scopePath = hit.path;
      scoped = all.filter((it) => it.path === hit.path || it.path.startsWith(hit.path + '/'));
    }

    const folders = scoped.filter((it) => it.isFolder);
    const files = scoped.filter((it) => !it.isFolder);

    const result = {
      scope: scopePath || '全部',
      folderCount: folders.length,
      fileCount: files.length,
      folders: folders.map((f) => f.path),
    };
    if (includeFiles) {
      result.files = files.map((f) => ({ path: f.path, title: f.title, fileId: f.fileId }));
    }
    result.tree = treeText(scoped);
    return result;
  } finally { cdp.close(); }
}

// 用主进程自己打开的接口按 fileId 打开导图（比点 DOM 稳）
async function openByFileId(cdp, node) {
  const arg = {
    iscloud: true,
    fileid: node.fileId,
    title: node.title,
    params: {},
    focus: true,
    opentab: true,
    filepath: null,
  };

  const invoke = () => cdp.eval(`(async () => {
    try { return { ok: true, r: await window.__runtime.invoke('wm:r-open-file', ${JSON.stringify(arg)}) }; }
    catch (e) { return { ok: false, err: String(e && e.message || e).slice(0, 160) }; }
  })()`);

  const waitEditor = async () => {
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const targets = await listTargets();
      const hit = targets.find((t) => (t.url || '').includes('editor.html') && (t.url || '').includes(node.fileId));
      if (hit) return { target: hit };
    }
    return null;
  };

  let lastErr = null;
  let activatedHome = false;
  let homeHidden = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1400); // 刚建的文件可能还没进索引
    if (attempt === 0) homeHidden = (await cdp.eval('document.visibilityState').catch(() => '')) === 'hidden';

    let r;
    try { r = await invoke(); } catch (e) { lastErr = e.message; continue; }

    if (!r || !r.ok) {
      lastErr = (r && r.err) || '调用失败';
      // 主进程找不到"当前活跃窗口"时就是这个 getURL 报错。
      // 只在失败时才去激活首页，避免无谓地改用户的标签页状态。
      if (!activatedHome && /getURL|undefined/.test(lastErr)) {
        activatedHome = true;
        const home = (await listTargets().catch(() => [])).find((t) => (t.url || '').includes('home.html'));
        if (home) await activateTarget(home.id).catch(() => {});
        await sleep(600);
      }
      continue;
    }

    const code = r.r && r.r.code;
    if (code !== undefined && code !== null && Number(code) !== 0 && Number(code) !== 200) {
      lastErr = `open-file 返回 code=${code}`;
      continue;
    }
    const hit = await waitEditor();
    if (hit) return hit;
    lastErr = '调用成功但编辑器窗口迟迟没出现';
  }
  return { target: null, err: lastErr || '未知错误', homeHidden };
}

const findTitleInHome = `(() => {
  const T = window.__ZX_TITLE;
  const cands = [...document.querySelectorAll('[class*=card_title],td,div,span,a')].filter((el) => {
    const t = (el.textContent || '').trim();
    if (t !== T) return false;
    const r = el.getBoundingClientRect();
    return r.y > 60 && r.width > 20 && r.height > 8 && r.width < 700;
  });
  if (!cands.length) return null;
  cands.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
  const r = cands[0].getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`;

// 兜底：在首页点卡片打开
async function openByClick(title) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cdp = await attachHome();
    try {
      const pos = await cdp.eval(`(() => { window.__ZX_TITLE = ${JSON.stringify(title)}; return ${findTitleInHome}; })()`);
      if (pos) {
        await click(cdp, pos.x, pos.y);
        await sleep(150);
        await click(cdp, pos.x, pos.y);
        await sleep(4500);
        return true;
      }
    } finally { cdp.close(); }
  }
  return false;
}

export async function openMap({ title, path, fileId } = {}) {
  const cdp = await attachHome();
  let node = null;
  try {
    const all = flattenTree(await fetchTree(cdp));
    const files = all.filter((it) => !it.isFolder);
    const norm = (s) => (s || '').replace(/\s+/g, '').toLowerCase();

    if (fileId) {
      node = files.find((f) => f.fileId === fileId) || { fileId, title: title || '' };
    } else if (path) {
      const q = String(path).replace(/^\/+|\/+$/g, '');
      const hit = files.filter((f) => norm(f.path) === norm(q));
      if (hit.length === 1) node = hit[0];
      else if (hit.length > 1) throw new Error(`路径「${path}」匹配到 ${hit.length} 个文件，请用 fileId：` + hit.map((h) => h.fileId).join(', '));
      else {
        const guess = files.filter((f) => norm(f.path).includes(norm(q))).map((f) => f.path);
        throw new Error(`没有找到路径为「${path}」的导图。` + (guess.length ? `相近的有：${guess.slice(0, 6).join('、')}` : ''));
      }
    } else if (title) {
      const hit = files.filter((f) => norm(f.title) === norm(title));
      if (hit.length === 1) node = hit[0];
      else if (hit.length > 1) {
        throw new Error(`有 ${hit.length} 张导图都叫「${title}」，请改用 path 或 fileId 指定：` + hit.map((h) => `${h.path}(${h.fileId})`).join('、'));
      } else {
        const guess = files.filter((f) => norm(f.title).includes(norm(title))).map((f) => f.path);
        throw new Error(`没有标题为「${title}」的导图。` + (guess.length ? `相近的有：${guess.slice(0, 6).join('、')}` : '可以先调用 zhixi_list_maps。'));
      }
    } else {
      throw new Error('需要提供 title、path 或 fileId 之一');
    }

    if (!node.fileId) throw new Error('解析不到该导图的 fileId');

    // 已经打开着就直接用，不要再调打开接口（省一次失败重试，也不会切走用户当前的标签页）
    const opened0 = (await listTargets()).find((t) => (t.url || '').includes('editor.html') && parseFileId(t.url) === node.fileId);
    if (opened0) {
      return {
        ok: true,
        alreadyOpen: true,
        title: opened0.title,
        fileId: node.fileId,
        path: node.path || null,
        note: '这张图已经是打开状态，可以直接对它读写节点',
      };
    }

    const opened = await openByFileId(cdp, node);
    if (opened.target) {
      const t = opened.target.title || '';
      return {
        ok: true,
        title: t && !/^editor\.html/.test(t) ? t : node.title,
        fileId: node.fileId,
        path: node.path || null,
        via: 'ipc',
      };
    }

    // 兜底走 UI 点击，但必须核对打开的 fileId —— 曾经这里直接取"最后一个编辑器窗口"，
    // 结果是打开失败却报成功，还把别人的图当成了目标，非常危险。
    const clicked = await openByClick(node.title);
    if (!clicked) {
      const why = opened.homeHidden
        ? '首页标签页不在前台（当前显示的是别的导图），知犀的打开接口在这种情况下不可用。'
        : `接口报错：${opened.err || '未知'}`;
      throw new Error(
        `打开「${node.title}」失败。${why}\n`
        + '处理办法（任选其一）：\n'
        + '1) 让用户在知犀里点一下标题栏左侧的「首页」标签，然后重试；\n'
        + '2) 在客户端里手动双击这张图打开，之后直接用节点工具，不必再 open。',
      );
    }
    const targets = await listTargets();
    const hit = targets.find((t) => (t.url || '').includes('editor.html') && parseFileId(t.url) === node.fileId);
    if (!hit) {
      throw new Error(`打开「${node.title}」失败，点击兜底也没有出现对应窗口。\n`
        + (opened.homeHidden ? '原因大概率是首页标签页不在前台（知犀的打开接口在该状态下不可用）。\n' : '')
        + '请让用户点一下标题栏左侧的「首页」标签，或在客户端里手动双击这张图，然后直接用节点工具。\n'
        + '这种情况下不要继续对节点做写操作。');
    }
    return {
      ok: true,
      title: hit.title,
      fileId: node.fileId,
      path: node.path || null,
      via: 'click',
    };
  } finally {
    cdp.close();
  }
}

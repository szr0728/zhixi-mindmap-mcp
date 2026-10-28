// 知犀驱动层：通过 CDP 操作运行中的客户端
import { Cdp, listTargets, sleep, ensureClient } from './cdp.js';

// 页面侧辅助脚本（幂等注入）
const PAGE_HELPERS = `(() => {
  if (window.__ZX) return true;
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
  const flat = (node, depth, out, parentId) => {
    const text = ((node.data && node.data.text) || '').replace(/\\n/g, '').trim();
    out.push({ id: node.id, text, depth, parentId: parentId || null });
    const kids = (node.children && node.children.normal) || [];
    kids.forEach((c) => flat(c, depth + 1, out, node.id));
    return out;
  };
  window.__ZX = {
    mm: findMM,
    tree() { const mm = findMM(); if (!mm) return null; return mm.store.toJson(); },
    nodes() { const t = this.tree(); if (!t) return null; return flat(t.root, 0, [], null); },
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
  fileId: (e.url || '').split('id=')[1] || null,
});

// hint 可以是 fileId（32 位十六进制，优先按 URL 精确匹配）或标题关键字
async function attachEditor(hint) {
  await ensureClient();
  const targets = await listTargets();
  const editors = targets.filter((t) => (t.url || '').includes('editor.html') && t.type === 'page');
  if (!editors.length) throw new Error('当前没有打开的导图。请先用 zhixi_open_map 打开一张，或在客户端里手动打开。');

  let t = null;
  if (hint) {
    const h = String(hint).trim();
    const byId = editors.filter((e) => (e.url || '').includes(h));
    if (byId.length) t = byId[0];
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
  await cdp.send('Page.enable').catch(() => {});
  // 让被遮挡的窗口也保持渲染
  await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await cdp.eval(PAGE_HELPERS);
  const ok = await cdp.eval('!!window.__ZX && !!window.__ZX.mm()');
  if (!ok) { cdp.close(); throw new Error('页面已连接，但还没找到导图实例（可能仍在加载）。稍等几秒重试。'); }
  return { cdp, target: t };
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
  return {
    editors: maps,
    hasHome: targets.some((t) => (t.url || '').includes('home.html')),
    needSpecify: maps.length > 1,
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

async function selectNode(cdp, id) {
  let rect = await cdp.eval(`window.__ZX.rect(${JSON.stringify(id)})`);
  if (!rect) {
    // 可能不在视口内，先定位到节点
    await cdp.eval(`(() => { const mm = window.__ZX.mm(); try { mm.moveNodeToViewCenter ? mm.moveNodeToViewCenter(${JSON.stringify(id)}) : mm.renderer && mm.renderer.moveNodeToViewCenter && mm.renderer.moveNodeToViewCenter(${JSON.stringify(id)}); } catch(e){} return true; })()`);
    await sleep(500);
    rect = await cdp.eval(`window.__ZX.rect(${JSON.stringify(id)})`);
  }
  if (!rect) throw new Error('找不到该节点在画布上的位置（可能已折叠或在其他视图）: ' + id);
  await click(cdp, rect.x, rect.y);
  await sleep(250);
}

async function typeIntoEditor(cdp, text, fast = false) {
  const has = await cdp.eval('!!window.__ZX.editorBox()');
  if (!has) throw new Error('没有进入文本编辑状态');
  await keyPress(cdp, 'a', 'KeyA', 65, 2); // Ctrl+A
  await sleep(fast ? 50 : 120);
  await cdp.send('Input.insertText', { text });
  await sleep(fast ? 110 : 250);
  await keyPress(cdp, 'Escape', 'Escape', 27);
  await sleep(fast ? 270 : 600);
}

export async function readTree(titleHint) {
  return withEditor(titleHint, async (cdp, target) => {
    const title = await cdp.eval('window.__ZX.title()');
    const nodes = await cdp.eval('window.__ZX.nodes()');
    return { mapTitle: title, id: (target.url.split('id=')[1] || ''), count: nodes.length, nodes };
  });
}

async function resolveId(cdp, { nodeId, text }) {
  if (nodeId) return nodeId;
  if (!text) throw new Error('需要提供 nodeId 或 text');
  const r = await cdp.eval(`(() => { const x = window.__ZX.resolve(${JSON.stringify(text)}); return { hits: x.hits.map(n => ({ id: n.id, text: n.text, depth: n.depth })), total: x.total }; })()`);
  if (!r.hits.length) throw new Error(`没有文字为「${text}」的节点。可以先调用 zhixi_read_tree 看看有哪些节点。`);
  if (r.hits.length > 1) throw new Error(`「${text}」匹配到 ${r.hits.length} 个节点，请改用 nodeId：` + r.hits.map((h) => `${h.id}(${h.text})`).join(', '));
  return r.hits[0].id;
}

// 批量新增同级子节点：第一个用「子主题」，其余用「主题」（同级），省掉反复选中父节点的开销
export async function addNodes({ parentId, parentText, texts }, titleHint) {
  const list = (Array.isArray(texts) ? texts : []).map((t) => String(t == null ? '' : t).trim()).filter((t) => t);
  if (!list.length) throw new Error('texts 需要是非空的文字数组');
  if (list.length > 60) throw new Error('一次不要超过 60 个节点，分批调用更稳');
  return withEditor(titleHint, async (cdp) => {
    const pid = await resolveId(cdp, { nodeId: parentId, text: parentText });
    await selectNode(cdp, pid);
    const t0 = Date.now();
    const timings = [];
    for (let i = 0; i < list.length; i++) {
      const ti = Date.now();
      const label = i === 0 ? '子主题' : '主题';
      const btn = await cdp.eval(`window.__ZX.toolbarBtn(${JSON.stringify(label)})`);
      const tQuery = Date.now() - ti;
      if (!btn) throw new Error(`工具栏没找到「${label}」按钮`);
      await click(cdp, btn.x, btn.y);
      const tClick = Date.now() - ti;
      await sleep(600);
      await typeIntoEditor(cdp, list[i], true);
      timings.push({ i, query: tQuery, clickDone: tClick, total: Date.now() - ti });
      if (timings.length > 6) timings.shift();
      if (process.env.ZHIXI_DEBUG) console.error('[timing]', JSON.stringify(timings[timings.length - 1]));
    }
    const nodes = await cdp.eval('window.__ZX.nodes()');
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
      timings,
    };
  });
}

export async function addNode({ parentId, parentText, text }, titleHint) {
  return withEditor(titleHint, async (cdp) => {
    const pid = await resolveId(cdp, { nodeId: parentId, text: parentText });
    await selectNode(cdp, pid);
    const btn = await cdp.eval(`window.__ZX.toolbarBtn('子主题')`);
    if (!btn) throw new Error('工具栏没找到「子主题」按钮');
    await click(cdp, btn.x, btn.y);
    await sleep(800);
    await typeIntoEditor(cdp, text);
    const nodes = await cdp.eval('window.__ZX.nodes()');
    const created = nodes.filter((n) => n.text === text.replace(/\n/g, '').trim() && n.parentId === pid);
    const sync = await waitSaved(cdp);
    return { ok: true, parentId: pid, created: created[0] || null, count: nodes.length, synced: sync.saved, ...sync };
  });
}

export async function updateNode({ nodeId, text, newText }, titleHint) {
  const finalText = newText ?? text;
  return withEditor(titleHint, async (cdp) => {
    const id = await resolveId(cdp, { nodeId, text });
    const rect = await cdp.eval(`window.__ZX.rect(${JSON.stringify(id)})`);
    if (!rect) throw new Error('节点不在可视区域，先调用 zhixi_read_tree 确认，或打开该分支');
    await click(cdp, rect.x, rect.y, true);
    await sleep(700);
    await typeIntoEditor(cdp, finalText);
    const nodes = await cdp.eval('window.__ZX.nodes()');
    const n = nodes.find((x) => x.id === id);
    const sync = await waitSaved(cdp);
    return { ok: true, nodeId: id, text: n ? n.text : finalText, synced: sync.saved, ...sync };
  });
}

export async function deleteNode({ nodeId, text, confirm }, titleHint) {
  if (!confirm) throw new Error('删除是破坏性操作：请先调用 zhixi_read_tree 确认节点，然后传 confirm=true 再执行。');
  return withEditor(titleHint, async (cdp) => {
    const id = await resolveId(cdp, { nodeId, text });
    const before = await cdp.eval('window.__ZX.nodes()');
    const target = before.find((n) => n.id === id);
    if (!target) throw new Error('节点不存在: ' + id);
    const subtree = collectSubtree(before, id);
    await selectNode(cdp, id);
    await keyPress(cdp, 'Delete', 'Delete', 46);
    await sleep(900);
    const after = await cdp.eval('window.__ZX.nodes()');
    const sync = await waitSaved(cdp);
    return { ok: true, deleted: { id, text: target.text, subtree }, remaining: after.length, synced: sync.saved, syncMs: sync.ms };
  });
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
  return withEditor(titleHint, async (cdp) => {
    const id = await resolveId(cdp, { nodeId, text });
    const tid = await resolveId(cdp, { nodeId: targetParentId, text: targetParentText });
    const before = await cdp.eval('window.__ZX.nodes()');
    const moved = before.find((n) => n.id === id);
    if (!moved) throw new Error('节点不存在: ' + id);
    if (id === tid) throw new Error('不能移动到自身下面');

    await selectNode(cdp, id);
    await keyPress(cdp, 'x', 'KeyX', 88, 2); // Ctrl+X
    await sleep(700);
    await selectNode(cdp, tid);
    await keyPress(cdp, 'v', 'KeyV', 86, 2); // Ctrl+V
    await sleep(1200);

    const after = await cdp.eval('window.__ZX.nodes()');
    const now = after.find((n) => n.text === moved.text && n.parentId === tid);
    if (!now) {
      // 兜底：粘回原位，避免节点丢失
      await selectNode(cdp, tid);
      throw new Error('移动未成功。节点可能还在剪贴板里，请重试或手动粘贴（Ctrl+V）。');
    }
    const sync = await waitSaved(cdp);
    return { ok: true, moved: moved.text, from: moved.parentId, to: tid, newId: now.id, count: after.length, synced: sync.saved, syncMs: sync.ms };
  });
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

  const text = await fetch(meta.url).then((r) => r.text());
  const hit = contains ? text.includes(contains) : null;
  return {
    title: meta.title,
    bytes: text.length,
    checked: contains || null,
    contains: hit,
    note: contains ? (hit ? '云端文件里已包含该文字，说明改动真的落盘了' : '云端文件里没有找到这段文字，可能还在同步，稍等再试') : '仅确认文件可读取',
  };
}

export async function screenshot(titleHint, outPath) {  return withEditor(titleHint, async (cdp) => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    if (outPath) writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
    return { base64: shot.data, bytes: Math.round(shot.data.length * 0.75), path: outPath || null };
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
  if (res && typeof res.code === 'number' && res.code !== 0) {
    throw new Error(`${channel} 返回错误 code=${res.code}` + (res.message ? `：${res.message}` : ''));
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
    return hit || { fileId, title: title || '', id: null, path: null, isFolder: wantFolder === true };
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

export async function createFolder({ title, folder, parentPath }) {
  if (!title || !String(title).trim()) throw new Error('文件夹名不能为空');
  const cdp = await attachHome();
  try {
    let pid = ROOT_PID;
    if (folder || parentPath) {
      const parent = await resolveItem(cdp, { path: parentPath || folder, wantFolder: true });
      pid = parent.id;
    }
    const fileId = await homeInvoke(cdp, 'fs:create-folder', { title: String(title).trim(), pid, password: '' });
    await sleep(1200);
    const all = flattenTree(await fetchTree(cdp));
    const created = all.find((it) => it.fileId === fileId) || null;
    return { ok: true, title, fileId, path: created ? created.path : null, parentId: pid };
  } finally { cdp.close(); }
}

// 新建导图：走界面「新建 → 思维导图」，再用接口改名/归位（接口直接建档需要模板参数，暂时走这条稳的路）
export async function createMap({ title, folder, parentPath }) {
  const before = (await listTargets()).filter((t) => (t.url || '').includes('editor.html')).map((t) => (t.url || '').split('id=')[1]);
  const cdp = await attachHome();
  let newId = null;
  try {
    const clickText = async (text) => {
      const pos = await cdp.eval(`(() => {
        const cands = [...document.querySelectorAll('div,span,button,a')].filter((el) => {
          const t = (el.textContent || '').trim();
          if (t !== ${JSON.stringify(text)}) return false;
          const r = el.getBoundingClientRect();
          return r.width > 8 && r.height > 8 && r.width < 400;
        });
        if (!cands.length) return null;
        cands.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
        const r = cands[0].getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (!pos) return false;
      await click(cdp, pos.x, pos.y);
      return true;
    };
    if (!(await clickText('新建'))) throw new Error('首页没找到「新建」按钮');
    await sleep(1800);
    if (!(await clickText('思维导图'))) throw new Error('模板页没找到「思维导图」模板');
    for (let i = 0; i < 30; i++) {
      await sleep(700);
      const now = (await listTargets()).filter((t) => (t.url || '').includes('editor.html')).map((t) => (t.url || '').split('id=')[1]);
      newId = now.find((id) => id && !before.includes(id));
      if (newId) break;
    }
    if (!newId) throw new Error('点了新建但没等到编辑器窗口出现');

    let pid = null;
    if (folder || parentPath) {
      const parent = await resolveItem(cdp, { path: parentPath || folder, wantFolder: true });
      pid = parent.id;
    }
    if (title) await homeInvoke(cdp, 'fs:rename-file', { title: String(title).trim(), fileId: newId, password: '' });
    if (pid !== null) await homeInvoke(cdp, 'fs:move-files', { dest: pid, fileIds: [newId], password: '' });
    await sleep(1500);
    const all = flattenTree(await fetchTree(cdp));
    const created = all.find((it) => it.fileId === newId);
    return { ok: true, fileId: newId, title: title || (created && created.title) || '(未命名)', path: created ? created.path : null };
  } finally { cdp.close(); }
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
    let dest = ROOT_PID;
    let destPath = '';
    if (toFolder !== undefined || toPath !== undefined) {
      const parent = await resolveItem(cdp, { path: toPath || toFolder, wantFolder: true });
      dest = parent.id;
      destPath = parent.path;
    }
    await homeInvoke(cdp, 'fs:move-files', { dest, fileIds: [item.fileId], password: '' });
    await sleep(1500);
    const all = flattenTree(await fetchTree(cdp));
    const now = all.find((it) => it.fileId === item.fileId);
    return { ok: true, fileId: item.fileId, title: item.title, to: destPath || '(根目录)', path: now ? now.path : null };
  } finally { cdp.close(); }
}

export async function deleteItem({ fileId, path, title, confirm }) {
  if (!confirm) throw new Error('删除是破坏性操作：请先确认目标，然后传 confirm=true。文件会进知犀回收站，可从客户端还原。');
  const cdp = await attachHome();
  try {
    const item = await resolveItem(cdp, { fileId, path, title });
    await homeInvoke(cdp, 'fs:mark-file-deleted', { fileIds: [item.fileId], password: '' });
    await sleep(1500);
    const all = flattenTree(await fetchTree(cdp));
    const stillThere = all.some((it) => it.fileId === item.fileId);
    return {
      ok: !stillThere,
      deleted: { title: item.title, path: item.path, isFolder: item.isFolder, fileId: item.fileId },
      note: stillThere ? '接口返回成功但目录里还能看到，可能尚未刷新，请稍后复查' : '已移入回收站',
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
  if (!raw || raw.code !== 0) {
    throw new Error('获取云文档目录失败：' + JSON.stringify(raw).slice(0, 160));
  }
  return raw.data || [];
}

// 把嵌套树拍平成带完整路径的列表；type 0 = 文件夹，1 = 导图文件
function flattenTree(nodes, parentPath = '') {
  const out = [];
  for (const n of nodes) {
    const isFolder = n.type === 0;
    const title = (n.title || '').trim() || '(未命名)';
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
  const r = await cdp.eval(`(async () => {
    try { return { ok: true, r: await window.__runtime.invoke('wm:r-open-file', ${JSON.stringify(arg)}) }; }
    catch (e) { return { ok: false, err: String(e && e.message || e) }; }
  })()`);
  if (!r.ok) return { target: null, err: r.err };

  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const targets = await listTargets();
    const hit = targets.find((t) => (t.url || '').includes('editor.html') && (t.url || '').includes(node.fileId));
    if (hit) return { target: hit };
  }
  return { target: null, err: '调用成功但编辑器窗口迟迟没出现' };
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

    // 兜底走 UI 点击
    const clicked = await openByClick(node.title);
    if (!clicked) throw new Error(`按 fileId 打开失败（${opened.err || '未知'}），首页点击也找不到「${node.title}」`);
    const targets = await listTargets();
    const ed = targets.filter((t) => (t.url || '').includes('editor.html'));
    const hit = ed.find((e) => (e.title || '').includes(node.title)) || ed[ed.length - 1];
    return {
      ok: true,
      title: hit ? hit.title : node.title,
      fileId: hit ? (hit.url.split('id=')[1] || null) : node.fileId,
      path: node.path || null,
      via: 'click',
    };
  } finally {
    cdp.close();
  }
}

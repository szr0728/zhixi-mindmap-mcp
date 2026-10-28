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

async function attachEditor(titleHint) {
  await ensureClient();
  const targets = await listTargets();
  const editors = targets.filter((t) => (t.url || '').includes('editor.html') && t.type === 'page');
  if (!editors.length) throw new Error('当前没有打开的导图。请先用 zhixi_open_map 打开一张，或在客户端里手动打开。');
  let t = editors[0];
  if (titleHint) {
    const hit = editors.find((e) => (e.title || '').includes(titleHint) || (e.url || '').includes(titleHint));
    if (hit) t = hit;
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
  return {
    editors: editors.map((e) => ({ title: e.title, id: (e.url.split('id=')[1] || '') })),
    hasHome: targets.some((t) => (t.url || '').includes('home.html')),
  };
}

async function click(cdp, x, y, doubleClick = false) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(80);
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

async function typeIntoEditor(cdp, text) {
  const has = await cdp.eval('!!window.__ZX.editorBox()');
  if (!has) throw new Error('没有进入文本编辑状态');
  await keyPress(cdp, 'a', 'KeyA', 65, 2); // Ctrl+A
  await sleep(120);
  await cdp.send('Input.insertText', { text });
  await sleep(250);
  await keyPress(cdp, 'Escape', 'Escape', 27);
  await sleep(600);
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
    return { ok: true, parentId: pid, created: created[0] || null, count: nodes.length };
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
    return { ok: true, nodeId: id, text: n ? n.text : finalText };
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
    return { ok: true, deleted: { id, text: target.text, subtree }, remaining: after.length };
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
    return { ok: true, moved: moved.text, from: moved.parentId, to: tid, newId: now.id, count: after.length };
  });
}

export async function screenshot(titleHint, outPath) {
  return withEditor(titleHint, async (cdp) => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    if (outPath) writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
    return { base64: shot.data, bytes: Math.round(shot.data.length * 0.75), path: outPath || null };
  });
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

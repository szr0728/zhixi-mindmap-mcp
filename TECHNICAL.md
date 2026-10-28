# 技术说明

面向想了解实现原理或打算二次开发的人。只想用的话看 [README.md](README.md) 就够了。

## 为什么必须驱动客户端

知犀官方有 REST API（`/api/v1/file/index`、`/api/v1/file/details`、`/api/import/mind`），但只有**列表 / 读取 / 导入**三类，没有任何节点级写接口。想在已有导图上增删改节点，只有一条路：驱动运行中的编辑器。

桌面客户端本质是 Electron 壳 + 网页编辑器，所以用 Chrome DevTools 协议接管它：

```
知犀桌面客户端（用户可见窗口）
      ▲  真实 UI 操作 + 云端 CRDT 同步
编辑器页面 editor.html?id=<fileId>
      ▲  Chrome DevTools Protocol（127.0.0.1:19222）
MCP Server（Node，stdio）
      ▲
WorkBuddy / Claude Desktop / 任意 MCP 客户端
```

走这条路的好处：改动当场可见、`Ctrl+Z` 可撤销、云端协作同步正常——因为它和手动操作完全等价。

## 启动参数为什么是四个

```bat
zhiximind-desktop.exe --remote-debugging-port=19222 --remote-allow-origins=* ^
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding ^
  --disable-features=CalculateNativeWinOcclusion
```

后三个不是可选优化。缺了它们，窗口被别的窗口完全遮挡时 Chromium 会停止出帧，`requestAnimationFrame` 不触发，表现是「模型改了、界面不动、连截图都是旧帧」——数据是对的，但你看不到，调试时极易误判成写入失败。

## 代码结构

| 文件 | 职责 |
|---|---|
| `src/cdp.js` | 调试协议客户端（HTTP 发现 + WebSocket + Runtime.evaluate），以及 `ensureClient()` 自动拉起客户端 |
| `src/driver.js` | 驱动层：页面内辅助脚本注入、节点定位、四类写操作。**知犀升级后要改就改这里** |
| `src/index.js` | MCP 服务与工具定义 |
| `test/client.mjs` | 不依赖宿主的命令行联调客户端 |

环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ZHIXI_CDP_PORT` | `19222` | 调试端口 |
| `ZHIXI_EXE` | `C:\Program Files\ZhiXi\ZXMind\zhiximind-desktop.exe` | 客户端路径 |

## 读：怎么拿到数据

`mm.store.toJson()`。`mm` 是编辑器的渲染器实例，页面**没有**把它挂到 `window` 上，所以是从 React fiber 树上扫 `bag.mindMap` 取到的：

```js
const rootEl = document.querySelector('#root,#app,body > div');
const fk = rootEl && Object.keys(rootEl).find(k => k.startsWith('__react'));
// 沿 fiber 树遍历 memoizedState / memoizedProps，找带 store 和 renderer 的 mindMap
```

节点树结构：`{ id, data: { text, richText }, children: { normal: [...] } }`。文档 id 形如 21 位 nanoid，分布在 `parentId / siblingId / nextId / firstChild` 上。

## 写：为什么全走 UI

| 操作 | 实际动作 |
|---|---|
| 新增子节点 | 点击父节点 → 点工具栏「子主题」→ Ctrl+A → `Input.insertText` → Esc |
| 改文字 | 双击节点 → Ctrl+A → `Input.insertText` → Esc |
| 删除 | 点击节点 → Delete |
| 移动 | Ctrl+X → 点击新父节点 → Ctrl+V |

节点与 DOM 的映射是 `g.zx-node[data-node-id="<uid>"]`，能精确拿到每个节点的 bbox 去点，不靠坐标猜位置。

**试过但放弃的两条路：**

1. `store.updateNodeData()` —— 真实签名是 `(id, key, value)` 而不是 `(id, dataObject)`，传对象会把 key 写成 `"[object Object]"`，污染数据。
2. 直写 Yjs doc（`store.share.get('nodes').get(uid).set('data', ...)`）—— 模型确实变了，但视图不刷新；而且随后会被云端版本覆盖回来。

根因：数据层是 Yjs CRDT，`store` 里的节点 `data` 只是本地缓存，权威副本在文档里，而视图刷新挂在应用自己的 effect 队列上。只有走应用真实的编辑链路，才能同时满足「写入文档」和「立即重绘」。

## 工具

| 工具 | 说明 |
|---|---|
| `zhixi_status` | 连通性 + 当前打开了哪些导图（多张时会提示必须指定 mapId） |
| `zhixi_list_maps` | 云端完整文件夹树，返回每个导图的路径 + fileId；可用 `folder` 只看某个目录 |
| `zhixi_search_maps` | 按标题关键字搜索，返回路径 + fileId |
| `zhixi_open_map` | 按 `path` / `fileId` / `title` 打开导图，走主进程 IPC |
| `zhixi_create_map` | 新建导图（可指定标题与存放文件夹） |
| `zhixi_create_folder` | 新建文件夹 |
| `zhixi_rename_item` | 给导图或文件夹改名 |
| `zhixi_move_item` | 移动到另一个文件夹 |
| `zhixi_delete_item` | 移入回收站（必须 `confirm: true`） |
| `zhixi_read_tree` | 导出节点树，含概要/外框/备注/折叠状态 |
| `zhixi_add_node` | 新增单个子节点 |
| `zhixi_add_nodes` | 批量新增同级子节点（比逐个调用快 3–4 倍） |
| `zhixi_update_node` | 改节点文字 |
| `zhixi_delete_node` | 删节点及子树（必须 `confirm: true`，返回被删子树） |
| `zhixi_move_node` | 把节点移到另一个节点下 |
| `zhixi_screenshot` | 截图当前画布 |
| `zhixi_verify_synced` | 拉云端文件，确认文字真的落盘 |

写操作建议用 `nodeId`。用文字定位时必须全图唯一，否则报错并列出候选 id——不做模糊匹配，避免删错。

**多图保护**：同时打开多张导图时，所有节点操作必须带 `mapId`，否则直接报错并列出已打开的图。这是故意的——早期版本会默认取第一个窗口，存在改错图的风险。

## 性能：mouseMoved 是毒药

编辑器页面上，**每次 `Input.dispatchMouseEvent({type:'mouseMoved'})` 会阻塞约 5000ms**。不是网络、不是渲染慢，而是一个雷打不动的 5 秒——窗口被遮挡时 Chromium 等不到帧确认，就把这个输入卡住了。

而 `mousePressed` / `mouseReleased` 只要 9ms。

对比（同一台机器、同一张图）：

| 操作 | 耗时 |
|---|---|
| mouseMoved + press + release | **5020 ms** |
| 只发 press + release（不发 move） | **10 ms** |
| 页面内 `el.click()` | 22 ms |

所以 `driver.js` 的 `click()` 里**故意不发 mouseMoved**，只发按下和抬起。少了这一行，整个工具从"每步 7 秒"变成"每步 1.3 秒"。改动这行之前请先想清楚。

顺带一提，节点选中用纯 press/release 也能生效，选中状态会在 `<g class="zx-node selected">` 上体现；但 SVG 节点上派发合成 `MouseEvent`（`new MouseEvent('click')`）**选不中**，应用不认。工具栏按钮反过来——`el.click()` 完全可行，比鼠标事件快 300 倍。


## 云文档目录：怎么拿到文件夹层级

首页 DOM 只能看到"当前这一屏"，拿不到目录树。真正的数据在**主进程**里，渲染进程通过 IPC 取。

给客户端加 `--inspect=9229` 后可以连上主进程的 Node inspector，`ipcMain._invokeHandlers` 里有 132 个通道。其中三个是关键：

| 通道 | 参数 | 作用 |
|---|---|---|
| `fs:query-file-tree` | `{recursive: true, includeFiles: true}`（**不要传 `pid: ''`**，传了会返回空） | 返回整棵目录树，`type: 0` 是文件夹、`type: 1` 是导图，节点形如 `{id, type, title, fileId, parentId, children[]}` |
| `fs:query-file-list` | `{pid, page, title, orderBy, limit}` | 分页列表 |
| `wm:r-open-file` | `{iscloud: true, fileid, title, params: {}, focus: true, opentab: true}`（注意是**小写 `fileid`**） | 按 fileId 直接开标签页，比点 DOM 稳得多 |

> 这些通道可以从渲染进程用 `window.__runtime.invoke(通道名, 参数)` 直接调，不需要连主进程。`--inspect` 只是当时用来"看有哪些通道、参数是什么"的。

渲染进程**没有** `require` / `process`（contextIsolation 开着），只能通过 preload 暴露的 `window.__runtime`（`invoke / send / sendMessage / on`）。之前失败过的 `m-files-list` 是应用内部的别名，真正注册在主进程里的是 `fs:*` 这一套。

## 已知限制

- 只支持 Windows（`tasklist` 检测进程、默认安装路径都是 Windows 的）。
- 客户端必须处于登录态且能连上知犀服务器。
- `zhixi_list_maps` / `zhixi_search_maps` 只覆盖**云端**导图，本地 `.zxmind` 文件不在里面。
- 同一文件夹里允许存在同名导图，这时按 `path` / `title` 定位会报"匹配到多个"，要改用 `fileId`。
- `zhixi_create_map` 走的是界面「新建 → 思维导图」，因为接口直接建档需要一整套模板参数。所以它会真的在屏幕上弹出新窗口。
- 删除导图/文件夹只进回收站，不会物理删除，可从客户端还原。
- 节点写入是模拟真人操作，**单节点约 1.3 秒**；批量新增 30 个节点约 40 秒。再快就需要改用应用内部的命令管道（`store.pipeCommands`），尚未实现。
- 节点必须在可视区域内（脚本会尝试居中，折叠分支需先展开）。
- **慢**：每次写操作模拟真人交互，单次 1–3 秒。批量改几十个节点会很难等，要快就得上直连注入，但那会牺牲同步可靠性。
- 客户端是 MCP 进程的子进程，MCP 退出时可能被系统回收；下次调用会自动重启，但之前打开的导图窗口不在了，要重新 `open_map`。
- 知犀升级后内部结构若变化，交互层可能需要小改。

## 免责声明

本项目通过 Chrome DevTools 协议控制你本机的客户端，属于自动化操作，**与知犀官方无关**，也未使用任何官方未公开接口写数据。使用前请自行备份重要导图。开启 `--remote-debugging-port` 期间，本机同用户的其他程序也能控制该客户端，用完建议正常退出客户端。

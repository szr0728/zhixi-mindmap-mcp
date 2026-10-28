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
| `zhixi_status` | 连通性 + 当前打开了哪些导图 |
| `zhixi_list_maps` | 列出首页可见的导图标题（读 DOM，只覆盖当前视图） |
| `zhixi_open_map` | 按标题双击打开导图 |
| `zhixi_read_tree` | 导出全部节点（id / 文字 / 层级 / 父节点） |
| `zhixi_add_node` | 在指定节点下新增子节点并写文字 |
| `zhixi_update_node` | 改节点文字 |
| `zhixi_delete_node` | 删节点及子树（必须 `confirm: true`，返回被删子树） |
| `zhixi_move_node` | 把节点移到另一个节点下 |
| `zhixi_screenshot` | 截图当前画布 |

写操作建议用 `nodeId`。用文字定位时必须全图唯一，否则报错并列出候选 id——不做模糊匹配，避免删错。

## 已知限制

- 只支持 Windows（`tasklist` 检测进程、默认安装路径都是 Windows 的）。
- 客户端必须处于登录态且能连上知犀服务器。
- 节点必须在可视区域内（脚本会尝试居中，折叠分支需先展开）。
- **慢**：每次写操作模拟真人交互，单次 1–3 秒。批量改几十个节点会很难等，要快就得上直连注入，但那会牺牲同步可靠性。
- 客户端是 MCP 进程的子进程，MCP 退出时可能被系统回收；下次调用会自动重启，但之前打开的导图窗口不在了，要重新 `open_map`。
- 知犀升级后内部结构若变化，交互层可能需要小改。

## 免责声明

本项目通过 Chrome DevTools 协议控制你本机的客户端，属于自动化操作，**与知犀官方无关**，也未使用任何官方未公开接口写数据。使用前请自行备份重要导图。开启 `--remote-debugging-port` 期间，本机同用户的其他程序也能控制该客户端，用完建议正常退出客户端。

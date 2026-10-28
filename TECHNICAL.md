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
| `test/unit.test.mjs` | 纯函数单元测试（`$...$` 转 Delta、fileId 解析），不需要启动客户端：`npm test` |

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
| 新增子节点 | 点击父节点 → 点工具栏「子主题」→ 用 Quill `setContents` 写入 → Esc |
| 改文字 | 双击节点 → Quill `setContents` 写入 → Esc |
| 删除 | 点击节点 → Delete |
| 移动 | Ctrl+X → 点击新父节点 → Ctrl+V |

节点与 DOM 的映射是 `g.zx-node[data-node-id="<uid>"]`，能精确拿到每个节点的 bbox 去点，不靠坐标猜位置。

**点击前必须用 `elementFromPoint` 校验**（`ensureClickable`）。只看坐标范围会出事：节点有一半在视口外时，中心点仍在界内，但 `getBoundingClientRect` 给的是未裁剪的坐标，点下去会落到旁边的节点上——实测就撞到过「想选分支主题1、实际选中了中心主题」。现在先问浏览器「这个点上是谁」，不是目标节点就先 `moveNodeToViewCenter`，还不行直接报错中止，绝不带病继续。

**试过但放弃的三条路：**

1. `store.updateNodeData()` —— 真实签名是 `(id, key, value)` 而不是 `(id, dataObject)`，传对象会把 key 写成 `"[object Object]"`，污染数据。
2. 直写 Yjs doc（`store.share.get('nodes').get(uid).set('data', ...)`）—— 模型确实变了，但视图不刷新；而且随后会被云端版本覆盖回来。
3. 模拟键入 `$...$` 让编辑器自动转公式 —— 知犀没有这个监听，`$...$` 只会原样当文字存下来。

根因：数据层是 Yjs CRDT，`store` 里的节点 `data` 只是本地缓存，权威副本在文档里，而视图刷新挂在应用自己的 effect 队列上。只有走应用真实的编辑链路，才能同时满足「写入文档」和「立即重绘」。

## 数学公式：Quill Delta + source='user'

节点的富文本藏在 `data.richText`，是标准 Quill Delta：

```json
{
  "text": "圆的方程：\n",
  "richText": { "ops": [
    { "insert": "圆的方程：" },
    { "insert": { "formula": "x^2+y^2=r^2" } },
    { "insert": "\n" }
  ] }
}
```

注意 `data.text` 是**丢掉公式后的纯文本**，所以只读 `text` 会把公式全丢了。读取时由 `deltaText()` 把 `formula` 还原成 `$latex$`，读写才能对齐。

写入的关键只有一条：**调 Quill API 必须传 `source='user'`**。

```js
const q = document.querySelector('.ql-container').__quill;  // 实例挂在容器上
q.setContents(delta, 'user');                                // 不传就白写
q.insertEmbed(idx, 'formula', latex, 'user');
```

默认的 `source='api'` 会被编辑器的 text-change 监听忽略，改动看着进了编辑器，Esc 一提交就没了——排查时极易误判成"编辑器不接收程序化输入"。实际是 source 的问题。

知犀注册的公式 blot 就是 Quill 标准的那套：`blotName="formula"`、`className="ql-formula"`、`tagName="SPAN"`，渲染靠 KaTeX（页面里 `katex` 全局对象和 `katex.min.css` 都加载好了）。

## 工具

| 工具 | 说明 |
|---|---|
| `zhixi_status` | 连通性 + 当前打开了哪些导图（多张时会提示必须指定 mapId） |
| `zhixi_list_maps` | 云端完整文件夹树，返回每个导图的路径 + fileId；可用 `folder` 只看某个目录 |
| `zhixi_search_maps` | 按标题关键字搜索，返回路径 + fileId |
| `zhixi_open_map` | 按 `path` / `fileId` / `title` 打开导图，走主进程 IPC |
| `zhixi_create_map` | 新建导图，走 `fs:create-file` 接口（不点界面），默认建完自动打开 |
| `zhixi_create_folder` | 新建文件夹 |
| `zhixi_rename_item` | 给导图或文件夹改名 |
| `zhixi_move_item` | 移动到另一个文件夹（会拒绝把文件夹移进自己的子目录） |
| `zhixi_delete_item` | 移入回收站。不带 `confirm` 只返回将被删的内容和子项数量 |
| `zhixi_read_tree` | 导出节点树，含概要/外框/备注/折叠状态；默认最多 400 个，超出标记 `truncated` |
| `zhixi_add_node` | 新增单个子节点 |
| `zhixi_add_nodes` | 批量新增同级子节点（比逐个调用快 3–4 倍），中途失败会报出已成功哪些 |
| `zhixi_update_node` | 改节点文字，写完会校对，不一致直接报错 |
| `zhixi_delete_node` | 删节点及子树（必须 `confirm: true`，返回被删子树，删完会核对节点确实消失） |
| `zhixi_move_node` | 把节点移到另一个节点下（拒绝目标在自己子树里，粘贴失败会重试） |
| `zhixi_screenshot` | 截图当前画布；超大图只落盘不内联 |
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

## 健壮性约定（改代码前必须知道）

这个项目所有写操作都是"模拟真人点一下"，一旦点错，代价是用户的数据。所以每步都做了前置校验 + 事后核对：

| 阶段 | 措施 |
|---|---|
| 定位 | `nodeId` 必须先确认存在于当前导图；用文字定位时要求全图唯一，多个命中直接报错并列出候选 |
| 点击前 | `elementFromPoint` 确认该坐标上的确实是目标节点；不在可点区域（视口外/被裁剪）先 `moveNodeToViewCenter`，仍不行就中止 |
| 点击后 | 检查 `g.zx-node.selected` 里是否真的是目标 id，不是就中止 |
| 写入后 | 改文字→比对内容；删除→确认节点确实没了且剩余数量对得上；新增→确认出现了新 id；移动→确认落到目标父节点下 |
| 并发 | 所有写操作进一个 promise 队列串行执行。并发调用会互相抢"当前选中节点"，交错执行等于点错节点 |
| 失败恢复 | 移动的粘贴失败会重试一次；`wm:r-open-file` 失败会重试三次并在 `getURL` 报错时尝试激活首页 |
| 进程级 | `unhandledRejection` / `uncaughtException` 兜住只打日志；CDP 通道断开时立刻 reject 所有等待中的调用，不干等超时 |

### 三个踩过的坑

**1. 首页按文字点「思维导图」会点到悬浮提示。** 左侧边栏同一项也有这个文案，`document.querySelectorAll` 会把 `.ant-tooltip-inner` 一起选出来，点它什么都不会发生——但代码看起来"点了"。现在 `zhixi_create_map` 完全不走 UI，直接用 `fs:create-file`：

```js
invoke('fs:create-file', { data: { type: 'structure', structure: 'none', trackFrom: 'zhixi-mcp' }, pid })
// → { code: 0, data: { fileId, isFolder: false } }
```

`type` 必须是字符串 `'structure'`（对应客户端里 `Zc.structure` 这个枚举值），传别的形状会返回 `code: 500`。

**2. `wm:r-open-file` 会因客户端标签页状态异常而报 `Cannot read properties of undefined (reading 'getURL')`。** 它内部靠"当前活跃窗口"找标签页宿主，窗口状态坏了就取不到。实测此时 `wm:r-get-tab-list` 返回空数组、首页 `visibilityState` 恒为 hidden、截图必然超时。**重启客户端即可恢复**（重启后 `via` 变回 `ipc`），代码里已在错误信息里给出这个提示。

**3. 打开导图的兜底路径曾经会"报成功但打开错文件"。** 旧逻辑在 IPC 失败后点击兜底，然后直接取"最后一个编辑器窗口"当结果——如果本来就开着别的图，就会把那张图的 fileId 返回给调用方，后续所有写操作都会落到错误的目标上。现在兜底必须校验 `parseFileId(url) === 目标 fileId`，不匹配就报错，绝不返回一个"看起来成功"的结果。

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

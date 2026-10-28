# zhixi-mcp

给 [知犀思维导图](https://www.zhixi.com) 桌面客户端做的 MCP 服务：让 AI 直接对**正在运行的客户端**做节点级增删改，改动实时显示在画布上，并通过客户端自己的 CRDT 通道同步到云端。

不是「导入 Markdown 生成新图」，是真正的**改已有导图**。

> MCP server for the Zhixi mind-map **desktop client**. It drives the running Electron app over the Chrome DevTools Protocol, so edits show up on screen instantly and sync through the app's own CRDT layer.

---

## 为什么是这条路

知犀官方有 REST API（`/api/v1/file/index`、`/api/v1/file/details`、`/api/import/mind`），但只有**列表 / 读取 / 导入**三类，没有任何节点级写接口。想在已有导图上增删改节点，只有一条路：驱动运行中的编辑器。

桌面客户端本质是 Electron 壳 + 网页编辑器，所以用 CDP 接管它即可：

```
知犀桌面客户端（用户可见窗口）
      ▲  真实 UI 操作 + 云端 CRDT 同步
编辑器页面 editor.html?id=<fileId>
      ▲  Chrome DevTools Protocol（127.0.0.1:19222）
MCP Server（Node，stdio）
      ▲
WorkBuddy / Claude Desktop / 任意 MCP 客户端
```

好处：改动当场可见、`Ctrl+Z` 可撤销、云端协作同步正常——因为它和手动操作完全等价。

---

## 安装

```bash
git clone https://github.com/szr0728/zhixi-mindmap-mcp.git
cd zhixi-mindmap-mcp
npm install
```

要求：Node ≥ 18（用到全局 `fetch` / `WebSocket`），Windows 客户端。

## 启动客户端

客户端必须带调试端口运行：

```bat
"C:\Program Files\ZhiXi\ZXMind\zhiximind-desktop.exe" ^
  --remote-debugging-port=19222 ^
  --remote-allow-origins=* ^
  --disable-backgrounding-occluded-windows ^
  --disable-renderer-backgrounding ^
  --disable-features=CalculateNativeWinOcclusion
```

Windows 用户可直接双击 `start-zhixi.cmd`。

**后三个参数不是可选项。** 不加的话，窗口被其他窗口完全遮挡时 Chromium 会停止出帧，`requestAnimationFrame` 不触发，表现就是「模型改了、界面不动、连截图都是旧帧」。这个坑排查了很久。

也可以不带参数启动——MCP 检测到端口不通会自己拉起客户端（见 `src/cdp.js` 的 `ensureClient`）。但有个前提：**知犀是单实例的**，如果它已经在正常运行，再启动带参数的进程只会把参数转给旧进程然后退出，端口永远起不来。这种情况必须先完全退出知犀（含托盘图标）。

## 配置 MCP

把 `mcp.example.json` 的内容合并进你的 MCP 配置文件，路径换成绝对路径：

- WorkBuddy：`~/.workbuddy/mcp.json`（Windows：`C:\Users\<你>\.workbuddy\mcp.json`）
- Claude Desktop：`claude_desktop_config.json`

```json
{
  "mcpServers": {
    "zhixi": {
      "command": "node",
      "args": ["C:/ABSOLUTE/PATH/TO/zhixi-mcp/src/index.js"],
      "env": { "ZHIXI_CDP_PORT": "19222" }
    }
  }
}
```

> Windows 上 `command` 建议写 node 的**绝对路径**。如果 node 是某个 IDE 内置的、不在系统 PATH 里，`"node"` 会启动失败。

改完配置**必须重启客户端**（WorkBuddy 只在启动时读 mcp.json），然后在连接器面板里点「信任」，之后开新会话生效。

环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ZHIXI_CDP_PORT` | `19222` | 调试端口 |
| `ZHIXI_EXE` | `C:\Program Files\ZhiXi\ZXMind\zhiximind-desktop.exe` | 客户端路径 |

## 工具

| 工具 | 说明 |
|---|---|
| `zhixi_status` | 连通性 + 当前打开了哪些导图 |
| `zhixi_list_maps` | 列出首页可见的导图标题 |
| `zhixi_open_map` | 按标题在客户端里打开导图 |
| `zhixi_read_tree` | 导出全部节点（id / 文字 / 层级 / 父节点） |
| `zhixi_add_node` | 在指定节点下新增子节点并写文字 |
| `zhixi_update_node` | 改节点文字 |
| `zhixi_delete_node` | 删节点及子树（必须 `confirm: true`） |
| `zhixi_move_node` | 把节点移到另一个节点下 |
| `zhixi_screenshot` | 截图当前画布 |

典型流程：

1. `zhixi_open_map {title: "某张导图"}`
2. `zhixi_read_tree` → 拿到 nodeId
3. `zhixi_add_node {parentId: "...", text: "新分支"}`
4. `zhixi_screenshot` 确认

写操作建议一律用 `nodeId`。用 `text` 定位时必须全图唯一，否则会报错并列出候选 id，不会瞎猜。

## 实现要点

**读**：`mm.store.toJson()`。`mm` 是编辑器的渲染器实例，从 React fiber 树上扫 `bag.mindMap` 拿到——页面没有把实例挂到 `window` 上。

**写**：全部走真实 UI 交互，不直接改内存。

| 操作 | 做法 |
|---|---|
| 新增子节点 | 选中父节点 → 点工具栏「子主题」→ 输入文字 → Esc |
| 改文字 | 双击节点 → Ctrl+A → 输入 → Esc |
| 删除 | 选中 → Delete |
| 移动 | Ctrl+X → 选中新父节点 → Ctrl+V |

节点与 DOM 的映射是 `g.zx-node[data-node-id="<uid>"]`，所以能精确取到每个节点的 bbox 去点，不靠坐标猜位置。

**为什么不用 `store.updateNodeData()` / 直写 Yjs doc？**
两条都试过，都不行。`updateNodeData` 的真实签名是 `(id, key, value)`，传对象会把 key 写成 `"[object Object]"`；就算写对了，模型变了视图不刷新，随后还会被云端版本覆盖回去。数据层是 Yjs CRDT，只有走应用自己的编辑链路才能同时满足「同步」和「重绘」。

## 已知限制

- 客户端必须处于**登录态**，并且能连上知犀服务器。
- 节点必须在**可视区域**内（脚本会尝试居中，但折叠的分支要先展开）。
- **慢**：每次写操作模拟真人交互，单次 1–3 秒。批量改几十个节点会很难等。
- 客户端是 MCP 进程的子进程，MCP 退出时可能被系统回收；下次调用会自动重启，但之前打开的导图窗口不在了，要重新 `open_map`。
- 只支持 Windows（`tasklist` 检测进程、默认安装路径都是 Windows 的）。
- 知犀升级后如果内部结构变了，交互层可能需要小改，集中在 `src/driver.js`。

## 本地联调

```bash
node test/client.mjs status
node test/client.mjs tree
node test/client.mjs add '{"parentText":"分支主题2","text":"新节点"}'
```

## 免责声明

本项目通过 Chrome DevTools 协议控制你本机的客户端，属于自动化操作，**与知犀官方无关**，也未使用任何官方未公开接口写数据。使用前请自行备份重要导图。开启 `--remote-debugging-port` 期间，本机同用户的其他程序也能控制该客户端，用完建议正常退出客户端。

## License

MIT

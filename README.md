# zhixi-mindmap-mcp

让 AI 直接改你的知犀思维导图：**在已经打开的导图上增删改节点**，改动实时显示在画布上，并自动同步到云端。

不是「生成一张新图给你」，是真的改你正在看的那张。

---

## 能干什么

| 能力 | 你可以这样说 |
|---|---|
| 找图 | 「考公文件夹里都有哪些导图」「搜一下名字带申论的」 |
| 管文档 | 「在申论下面新建一张导图叫『万能模板』」「把这张图挪到事业编」「这个文件夹改名」 |
| 读结构 | 「把这张导图的节点结构念给我听」 |
| 加节点 | 「在『安装系统』下面加三个子节点：分区、格式化、装系统」 |
| 加公式 | 「加一个节点写圆的方程 x²+y²=r²」——会自动排成真正的数学公式，不是文字 |
| 改文字 | 「把『组RAID1』改成『配置 RAID1』」 |
| 删节点 | 「删掉测试用的那个分支」 |
| 移动节点 | 「把『IPMI』整块挪到『硬件准备』下面」 |
| 截图 | 「截个图给我看看现在长什么样」 |

改完你抬头看屏幕就知道对不对，`Ctrl+Z` 还能撤销——它和你手动点出来的效果完全一样。一次加十几个节点也能撑住，内部走的是批量通道，单个节点约 1 秒多。

## 数学公式

节点文字里用 `$...$` 包住 LaTeX，就会渲染成知犀自己的公式对象（KaTeX 排版），和你在编辑器里点「公式」插进去的效果一模一样：

| 你说 | 实际写入的内容 |
|---|---|
| 圆的方程 x²+y²=r² | `圆的方程：$x^2+y^2=r^2$` |
| 椭圆标准式 | `$\frac{x^2}{a^2}+\frac{y^2}{b^2}=1$` |
| 级数收敛 | `$\sum_{n=1}^{\infty}u_n$` |

一个节点里可以混排多段公式，公式之外的文字正常显示。`zhixi_read_tree` 读回来时也会还原成同样的 `$...$` 写法，所以读出来再写回去不会丢公式。

不用自己加 `$` 也行——直接说「加个节点写圆的方程 x²+y²=r²」，AI 会转成上面的写法。

---

## 安装：交给 AI，别自己敲命令

把下面**整段**粘给任意能执行命令的 AI（WorkBuddy / Claude Code / Cursor / Codex 都行）：

```text
帮我安装并配置 zhixi-mindmap-mcp 这个 MCP 服务。

仓库地址：https://github.com/szr0728/zhixi-mindmap-mcp

请你全程自己动手，按顺序做完，最后用一段话告诉我结果：

1) 把仓库 clone 到一个长期保留的目录（Windows 建议 C:\Tools\zhixi-mindmap-mcp，别放临时目录），
   然后 npm install。国内网络慢就加参数 --registry=https://registry.npmmirror.com

2) 取到 node 的绝对路径（执行 node -e "console.log(process.execPath)" 的输出），备用。

3) 编辑用户级 MCP 配置文件：~/.workbuddy/mcp.json
   （Windows 即 C:\Users\<用户名>\.workbuddy\mcp.json；文件不存在就新建，内容是 {}）
   在 mcpServers 里【追加】一条 zhixi，不要覆盖已有条目，合并后的结构是：

   {
     "mcpServers": {
       "zhixi": {
         "command": "<第2步拿到的 node 绝对路径>",
         "args": ["<仓库目录绝对路径>/src/index.js"],
         "env": { "ZHIXI_CDP_PORT": "19222" }
       }
     }
   }

   注意：Windows 路径在 JSON 里要么用双反斜杠，要么用正斜杠。

4) 检查知犀客户端有没有开调试端口：
   curl http://127.0.0.1:19222/json/version
   - 有返回 → 跳过
   - 连不上 → 说明客户端没在带调试端口运行。知犀是单实例的，先确认它已完全退出
     （窗口关掉、右下角托盘图标也要退出），再执行仓库里的 start-zhixi.cmd

5) 告诉我：WorkBuddy 只在启动时读取 mcp.json，必须【完全退出客户端再重新打开】
   （含托盘），重开后到「专家·技能·连接器 → 连接器 → 右上角自定义连接器」里
   找到 zhixi，点「信任」。这一步必须我自己点，你没法代劳。

6) 我信任完之后，你来验证：先调用 zhixi_status 看连通性，再 zhixi_list_maps 列出导图，
   用 zhixi_open_map 打开其中一张，然后 zhixi_read_tree 把节点树摘要给我看。
   如果哪一步失败，把具体报错告诉我并给出修复方案。
```

AI 拿到这段会自己 clone、装依赖、找 node 路径、改配置、检查端口。你只需要在最后点一次「信任」。

> 想换目录或端口，只改提示词里的路径和 `ZHIXI_CDP_PORT` 就行。

---

## 手动安装（不想用 AI 的话）

1. `git clone https://github.com/szr0728/zhixi-mindmap-mcp.git && cd zhixi-mindmap-mcp && npm install`
2. 把 `mcp.example.json` 的内容合并进 `~/.workbuddy/mcp.json`，路径换成绝对路径
3. 双击 `start-zhixi.cmd` 启动知犀（已开着的话先彻底退出）
4. **完全重启**宿主客户端 → 连接器面板点「信任」→ 开新会话

Claude Desktop 等其它宿主同理，配置文件换成 `claude_desktop_config.json`。

---

## 三个容易踩的坑

| 坑 | 说明 |
|---|---|
| 改完配置没反应 | 宿主只在启动时读 mcp.json，**必须完全退出重开**，不是关窗口 |
| 端口起不来 | 知犀单实例。已经在跑普通实例时，带参数再启动无效，得先从托盘退干净 |
| 界面「改了不动」 | 客户端必须带 `start-zhixi.cmd` 里那三个 `--disable-*` 参数启动，否则窗口被遮挡时 Chromium 停止渲染 |

---

技术原理、实现细节、已知限制见 [TECHNICAL.md](TECHNICAL.md)。

## License

MIT

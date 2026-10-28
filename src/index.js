import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  status, listMaps, openMap, readTree, addNode, updateNode, deleteNode, moveNode, screenshot,
} from './driver.js';

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ content: [{ type: 'text', text: '错误：' + (e.message || String(e)) }], isError: true });

const server = new McpServer(
  { name: 'zhixi-mindmap', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

const wrap = (fn) => async (args) => {
  try { return await fn(args || {}); } catch (e) { return fail(e); }
};

server.registerTool(
  'zhixi_status',
  {
    title: '知犀连接状态',
    description: '检查知犀桌面客户端是否可连接，以及当前打开了哪些导图。任何操作前可先调用。',
    inputSchema: {},
  },
  wrap(async () => {
    const s = await status();
    return text({
      connected: true,
      openEditors: s.editors,
      hint: s.editors.length ? '已打开导图，可直接读写节点' : '还没有打开的导图，先调用 zhixi_open_map 或在客户端里打开一张',
    });
  }),
);

server.registerTool(
  'zhixi_list_maps',
  {
    title: '列出我的导图',
    description: '读取知犀客户端首页显示的导图标题列表（我的云文档 / 最近），用于挑选要操作的目标。',
    inputSchema: {},
  },
  wrap(async () => text(await listMaps())),
);

server.registerTool(
  'zhixi_open_map',
  {
    title: '打开导图',
    description: '在知犀客户端里按标题打开一张导图（会在用户屏幕上真实打开窗口）。写操作前需要先打开目标导图。',
    inputSchema: { title: z.string().describe('导图标题，需与首页显示一致') },
  },
  wrap(async ({ title }) => text(await openMap({ title }))),
);

server.registerTool(
  'zhixi_read_tree',
  {
    title: '读取导图节点树',
    description: '导出当前导图的全部节点（id / 文字 / 层级 / 父节点）。写操作前先用它拿到 nodeId。',
    inputSchema: { mapTitle: z.string().optional().describe('当前打开了多张导图时，用标题关键字指定') },
  },
  wrap(async ({ mapTitle }) => text(await readTree(mapTitle))),
);

server.registerTool(
  'zhixi_add_node',
  {
    title: '新增子节点',
    description: '在指定节点下新增一个子节点并写入文字。parentId 或 parentText 二选一，优先用 parentId。',
    inputSchema: {
      parentId: z.string().optional().describe('父节点 id（来自 zhixi_read_tree）'),
      parentText: z.string().optional().describe('父节点文字（必须全图唯一）'),
      text: z.string().describe('新节点的文字'),
      mapTitle: z.string().optional(),
    },
  },
  wrap(async (a) => text(await addNode(a, a.mapTitle))),
);

server.registerTool(
  'zhixi_update_node',
  {
    title: '修改节点文字',
    description: '把某个节点的文字改成新内容。nodeId 或 text 定位节点，newText 为新内容。',
    inputSchema: {
      nodeId: z.string().optional().describe('节点 id'),
      text: z.string().optional().describe('节点当前文字（必须全图唯一）'),
      newText: z.string().describe('修改后的文字'),
      mapTitle: z.string().optional(),
    },
  },
  wrap(async (a) => text(await updateNode(a, a.mapTitle))),
);

server.registerTool(
  'zhixi_delete_node',
  {
    title: '删除节点',
    description: '删除节点及其整棵子树。破坏性操作：必须先传 confirm=true。会返回被删除的子树内容。',
    inputSchema: {
      nodeId: z.string().optional().describe('节点 id'),
      text: z.string().optional().describe('节点文字（必须全图唯一）'),
      confirm: z.boolean().optional().describe('必须为 true 才会真正删除'),
      mapTitle: z.string().optional(),
    },
  },
  wrap(async (a) => text(await deleteNode(a, a.mapTitle))),
);

server.registerTool(
  'zhixi_move_node',
  {
    title: '移动节点',
    description: '把节点移动到另一个节点下面（成为其子节点）。用 nodeId/text 指定要移动的节点，用 targetParentId/targetParentText 指定新父节点。',
    inputSchema: {
      nodeId: z.string().optional(),
      text: z.string().optional(),
      targetParentId: z.string().optional(),
      targetParentText: z.string().optional(),
      mapTitle: z.string().optional(),
    },
  },
  wrap(async (a) => text(await moveNode(a, a.mapTitle))),
);

server.registerTool(
  'zhixi_screenshot',
  {
    title: '截图当前画布',
    description: '截取当前导图画布，用于确认改动效果。可选 savePath 保存为本地 PNG。',
    inputSchema: {
      savePath: z.string().optional().describe('保存路径，例如 C:/Users/xxx/Desktop/map.png'),
      mapTitle: z.string().optional(),
    },
  },
  wrap(async ({ savePath, mapTitle }) => {
    const r = await screenshot(mapTitle, savePath);
    return {
      content: [
        { type: 'image', data: r.base64, mimeType: 'image/png' },
        { type: 'text', text: `已截图${r.path ? '，保存到 ' + r.path : ''}（约 ${Math.round(r.bytes / 1024)} KB）` },
      ],
    };
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[zhixi-mcp] ready');

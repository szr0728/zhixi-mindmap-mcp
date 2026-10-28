import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  status, listMaps, openMap, readTree, addNode, updateNode, deleteNode, moveNode, screenshot, cloudCheck,
} from './driver.js';

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const hint = (a) => (a && (a.mapId || a.mapTitle)) || undefined;
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
    let hint;
    if (!s.editors.length) hint = '还没有打开的导图，先调用 zhixi_open_map 或在客户端里打开一张';
    else if (s.needSpecify) hint = '同时打开了多张导图，所有节点操作都必须带 mapId（下面的 fileId）指定改哪一张';
    else hint = '已打开导图，可直接读写节点';
    return text({ connected: true, openEditors: s.editors, needSpecify: s.needSpecify, hint });
  }),
);

server.registerTool(
  'zhixi_list_maps',
  {
    title: '列出我的导图（含文件夹）',
    description: '读取云端真实的文件夹树，返回每个导图的完整路径（如「考公/申论/万能思维体系」）和 fileId。可用 folder 参数只看某个文件夹。',
    inputSchema: {
      folder: z.string().optional().describe('只看这个文件夹（写文件夹名或完整路径，如「考公」或「考公/申论」）'),
      includeFiles: z.boolean().optional().describe('是否列出导图文件，默认 true；只要文件夹树时传 false'),
    },
  },
  wrap(async (a) => text(await listMaps(a))),
);

server.registerTool(
  'zhixi_open_map',
  {
    title: '打开导图',
    description: '在知犀客户端里打开导图（会在用户屏幕上真实打开窗口）。三种定位方式任选一种：path（完整路径，最准）、fileId（来自 zhixi_list_maps）、title（标题，必须全库唯一）。',
    inputSchema: {
      path: z.string().optional().describe('完整路径，如「考公/申论/万能思维体系」'),
      fileId: z.string().optional().describe('导图 id，来自 zhixi_list_maps 的 files[].fileId'),
      title: z.string().optional().describe('导图标题；同名多于一个时会报错并列出候选路径'),
    },
  },
  wrap(async (a) => text(await openMap(a))),
);

server.registerTool(
  'zhixi_read_tree',
  {
    title: '读取导图节点树',
    description: '导出当前导图的全部节点（id / 文字 / 层级 / 父节点）。写操作前先用它拿到 nodeId。',
    inputSchema: { mapId: z.string().optional().describe('导图 id（同时打开多张时必传）'), mapTitle: z.string().optional().describe('导图标题关键字（仅一张匹配时可用）') },
  },
  wrap(async (a) => text(await readTree(hint(a)))),
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
      mapId: z.string().optional().describe(`导图 id（同时打开多张时必传，来自 zhixi_status 或 zhixi_list_maps）`),
      mapTitle: z.string().optional().describe(`导图标题关键字`),
    },
  },
  wrap(async (a) => text(await addNode(a, hint(a)))),
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
      mapId: z.string().optional().describe(`导图 id（同时打开多张时必传，来自 zhixi_status 或 zhixi_list_maps）`),
      mapTitle: z.string().optional().describe(`导图标题关键字`),
    },
  },
  wrap(async (a) => text(await updateNode(a, hint(a)))),
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
      mapId: z.string().optional().describe(`导图 id（同时打开多张时必传，来自 zhixi_status 或 zhixi_list_maps）`),
      mapTitle: z.string().optional().describe(`导图标题关键字`),
    },
  },
  wrap(async (a) => text(await deleteNode(a, hint(a)))),
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
      mapId: z.string().optional().describe(`导图 id（同时打开多张时必传，来自 zhixi_status 或 zhixi_list_maps）`),
      mapTitle: z.string().optional().describe(`导图标题关键字`),
    },
  },
  wrap(async (a) => text(await moveNode(a, hint(a)))),
);

server.registerTool(
  'zhixi_screenshot',
  {
    title: '截图当前画布',
    description: '截取当前导图画布，用于确认改动效果。可选 savePath 保存为本地 PNG。',
    inputSchema: {
      savePath: z.string().optional().describe('保存路径，例如 C:/Users/xxx/Desktop/map.png'),
      mapId: z.string().optional().describe(`导图 id（同时打开多张时必传，来自 zhixi_status 或 zhixi_list_maps）`),
      mapTitle: z.string().optional().describe(`导图标题关键字`),
    },
  },
  wrap(async (a) => {
    const r = await screenshot(hint(a), a.savePath);
    return {
      content: [
        { type: 'image', data: r.base64, mimeType: 'image/png' },
        { type: 'text', text: `已截图${r.path ? '，保存到 ' + r.path : ''}（约 ${Math.round(r.bytes / 1024)} KB）` },
      ],
    };
  }),
);

server.registerTool(
  'zhixi_verify_synced',
  {
    title: '验证改动已同步到云端',
    description: '直接从云端拉取导图文件，确认某段文字真的存进去了（而不是只改了本地内存）。写完重要内容后可以调一次确认。',
    inputSchema: {
      mapId: z.string().describe('导图 id（fileId）'),
      contains: z.string().optional().describe('要确认存在的文字，比如刚新增的节点文字'),
    },
  },
  wrap(async (a) => text(await cloudCheck(a))),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[zhixi-mcp] ready');

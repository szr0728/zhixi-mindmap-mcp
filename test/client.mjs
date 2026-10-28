// 简易 MCP 客户端，用于本地联调
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const proc = spawn(process.execPath, ['src/index.js'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'inherit'] });
const rl = createInterface({ input: proc.stdout });
let id = 0;
const pending = new Map();

rl.on('line', (line) => {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});

const rpc = (method, params) => new Promise((res) => {
  const myId = ++id;
  pending.set(myId, res);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
});

const call = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.error) return { error: r.error };
  const c = r.result?.content || [];
  const txt = c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  const img = c.some((x) => x.type === 'image');
  return { isError: r.result?.isError, text: txt, hasImage: img };
};

const main = async () => {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await rpc('tools/list', {});
  console.log('TOOLS:', (list.result?.tools || []).map((t) => t.name).join(', '));

  const cmd = process.argv[2] || 'status';
  if (cmd === 'status') console.log(JSON.stringify(await call('zhixi_status'), null, 1).slice(0, 800));
  if (cmd === 'tree') {
    const r = await call('zhixi_read_tree');
    console.log(r.text?.slice(0, 1500));
  }
  if (cmd === 'maps') console.log(JSON.stringify(await call('zhixi_list_maps', JSON.parse(process.argv[3] || '{}')), null, 1).slice(0, 1500));
  if (cmd === 'add') console.log(JSON.stringify(await call('zhixi_add_node', JSON.parse(process.argv[3])), null, 1).slice(0, 800));
  if (cmd === 'upd') console.log(JSON.stringify(await call('zhixi_update_node', JSON.parse(process.argv[3])), null, 1).slice(0, 800));
  if (cmd === 'del') console.log(JSON.stringify(await call('zhixi_delete_node', JSON.parse(process.argv[3])), null, 1).slice(0, 800));
  if (cmd === 'move') console.log(JSON.stringify(await call('zhixi_move_node', JSON.parse(process.argv[3])), null, 1).slice(0, 800));
  if (cmd === 'shot') console.log(JSON.stringify(await call('zhixi_screenshot', JSON.parse(process.argv[3] || '{}')), null, 1).slice(0, 400));
  if (cmd === 't') console.log(JSON.stringify(await call(process.argv[3], JSON.parse(process.argv[4] || '{}')), null, 1).slice(0, 1200));
  if (cmd === 'verify') console.log(JSON.stringify(await call('zhixi_verify_synced', JSON.parse(process.argv[3])), null, 1).slice(0, 600));
  if (cmd === 'open') console.log(JSON.stringify(await call('zhixi_open_map', JSON.parse(process.argv[3])), null, 1).slice(0, 600));

  proc.stdin.end();
  setTimeout(() => { proc.kill(); process.exit(0); }, 300);
};

main();

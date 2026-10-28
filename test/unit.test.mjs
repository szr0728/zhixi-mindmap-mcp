// 纯函数单元测试，不需要启动知犀客户端：node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { textToDelta } from '../src/driver.js';
import { parseFileId } from '../src/cdp.js';

const ops = (t) => textToDelta(t).ops;

test('纯文本：单个字符串 op，末尾补换行', () => {
  assert.deepEqual(ops('分支主题'), [{ insert: '分支主题\n' }]);
});

test('纯文本已带换行时不重复补', () => {
  assert.deepEqual(ops('分支主题\n'), [{ insert: '分支主题\n' }]);
});

test('空字符串也能生成合法的 delta', () => {
  const d = textToDelta('');
  assert.equal(d.ops.length, 1);
  assert.equal(d.ops[0].insert, '\n');
});

test('中间夹一个公式', () => {
  assert.deepEqual(ops('圆的方程：$x^2+y^2=r^2$'), [
    { insert: '圆的方程：' },
    { insert: { formula: 'x^2+y^2=r^2' } },
    { insert: '\n' },
  ]);
});

test('多个公式', () => {
  assert.deepEqual(ops('$a$ 和 $b$'), [
    { insert: { formula: 'a' } },
    { insert: ' 和 ' },
    { insert: { formula: 'b' } },
    { insert: '\n' },
  ]);
});

test('公式在结尾时单独补一个换行 op', () => {
  assert.deepEqual(ops('结论：$\\pi$'), [
    { insert: '结论：' },
    { insert: { formula: '\\pi' } },
    { insert: '\n' },
  ]);
});

test('\\$ 是字面美元号，不当作公式', () => {
  assert.deepEqual(ops('价格 \\$5 和 \\$6'), [{ insert: '价格 $5 和 $6\n' }]);
});

test('只有一个 $ 时不当作公式', () => {
  assert.deepEqual(ops('成本 $100'), [{ insert: '成本 $100\n' }]);
});

test('跨行不当作公式', () => {
  assert.deepEqual(ops('$a\nb$'), [{ insert: '$a\nb$\n' }]);
});

test('公式里可以带反斜杠命令', () => {
  assert.deepEqual(ops('$\\dfrac{a}{b}$'), [
    { insert: { formula: '\\dfrac{a}{b}' } },
    { insert: '\n' },
  ]);
});

test('parseFileId：标准编辑器 URL', () => {
  assert.equal(parseFileId('file:///C:/app/resources/dist/renderer/editor.html?id=551c2a75c69535801a68d634f8121a64'),
    '551c2a75c69535801a68d634f8121a64');
});

test('parseFileId：后面还有别的参数时不带进 fileId', () => {
  assert.equal(parseFileId('editor.html?id=abc123&tab=1'), 'abc123');
});

test('parseFileId：有 hash 时忽略 hash', () => {
  assert.equal(parseFileId('editor.html?id=abc123#top'), 'abc123');
});

test('parseFileId：没有 id 时返回 null', () => {
  assert.equal(parseFileId('home.html'), null);
  assert.equal(parseFileId(''), null);
  assert.equal(parseFileId(null), null);
});

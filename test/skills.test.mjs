import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-skills-'));
process.env.HOME = home;
const skills = await import('../skills.mjs');

test('技能装到共用目录、标记为 claclaw 装的，卸载只删自己装的', () => {
  assert.equal(skills.stateAt('claclaw-peer', 'agents'), 'none');
  skills.install('claclaw-peer', 'agents');
  const dest = path.join(home, '.agents', 'skills', 'claclaw-peer');
  assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
  assert.equal(skills.stateAt('claclaw-peer', 'agents'), 'ours');
  assert.ok(skills.installedFor('claclaw-peer', 'openclaw'));
  assert.ok(!skills.installedFor('claclaw-peer', 'claude'));
  skills.uninstall('claclaw-peer', 'agents');
  assert.equal(skills.stateAt('claclaw-peer', 'agents'), 'none');
});

test('用户自己的同名技能不覆盖、不删除', () => {
  const dest = path.join(home, '.claude', 'skills', 'claclaw-peer');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'SKILL.md'), '自己的');
  assert.equal(skills.stateAt('claclaw-peer', 'claude'), 'foreign');
  assert.throws(() => skills.install('claclaw-peer', 'claude'), /同名技能/);
  assert.throws(() => skills.uninstall('claclaw-peer', 'claude'), /不是 claclaw 装的/);
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), '自己的');
});

test('仓库里的技能更新后，启动时同步到装过的复制件', () => {
  skills.install('claclaw-peer', 'agents');
  const f = path.join(home, '.agents', 'skills', 'claclaw-peer', 'SKILL.md');
  fs.writeFileSync(path.join(home, '.agents', 'skills', 'claclaw-peer', '.claclaw-skill'), JSON.stringify({ from: 'claclaw', version: 'old' }));
  fs.writeFileSync(f, '旧版');
  skills.syncInstalled();
  assert.notEqual(fs.readFileSync(f, 'utf8'), '旧版');
});

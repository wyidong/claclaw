import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-skills-'));
// os.homedir() 在 Windows 上不看 HOME，只看 USERPROFILE —— 只设 HOME 的话这组测试会写进
// 使用者真实的 ~/.agents/skills、~/.claude/skills，把人家的技能目录弄脏。两个都要设。
process.env.HOME = home;
process.env.USERPROFILE = home;
const skills = await import('../src/skills.mjs');

test('技能装到共用目录、标记为 claclaw 装的，卸载只删自己装的', () => {
  assert.equal(skills.stateAt('claw-interconnect', 'agents'), 'none');
  skills.install('claw-interconnect', 'agents');
  const dest = path.join(home, '.agents', 'skills', 'claw-interconnect');
  assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
  assert.equal(skills.stateAt('claw-interconnect', 'agents'), 'ours');
  assert.ok(skills.installedFor('claw-interconnect', 'openclaw'));
  assert.ok(!skills.installedFor('claw-interconnect', 'claude'));
  skills.uninstall('claw-interconnect', 'agents');
  assert.equal(skills.stateAt('claw-interconnect', 'agents'), 'none');
});

test('用户自己的同名技能不覆盖、不删除', () => {
  const dest = path.join(home, '.claude', 'skills', 'claw-interconnect');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'SKILL.md'), '自己的');
  assert.equal(skills.stateAt('claw-interconnect', 'claude'), 'foreign');
  assert.throws(() => skills.install('claw-interconnect', 'claude'), /同名技能/);
  assert.throws(() => skills.uninstall('claw-interconnect', 'claude'), /不是 claclaw 装的/);
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), '自己的');
});

test('仓库里的技能更新后，启动时同步到装过的复制件', () => {
  skills.install('claw-interconnect', 'agents');
  const f = path.join(home, '.agents', 'skills', 'claw-interconnect', 'SKILL.md');
  fs.writeFileSync(path.join(home, '.agents', 'skills', 'claw-interconnect', '.claclaw-skill'), JSON.stringify({ from: 'claclaw', version: 'old' }));
  fs.writeFileSync(f, '旧版');
  skills.syncInstalled();
  assert.notEqual(fs.readFileSync(f, 'utf8'), '旧版');
});

test('用到 Claw 时按 auto 自动装：Claude 只装 claw-file，别的 Claw 两个都装；用户自己的同名技能不动', () => {
  for (const t of ['claude', 'agents']) for (const n of ['claw-interconnect', 'claw-file']) if (skills.stateAt(n, t) === 'ours') skills.uninstall(n, t);
  fs.rmSync(path.join(home, '.claude', 'skills', 'claw-interconnect'), { recursive: true, force: true });
  skills.ensure('claude');
  assert.equal(skills.stateAt('claw-file', 'claude'), 'ours');
  assert.equal(skills.stateAt('claw-interconnect', 'claude'), 'none');
  skills.ensure('qwen');
  assert.equal(skills.stateAt('claw-file', 'agents'), 'ours');
  assert.equal(skills.stateAt('claw-interconnect', 'agents'), 'ours');
  const own = path.join(home, '.claude', 'skills', 'claw-file');
  skills.uninstall('claw-file', 'claude');
  fs.mkdirSync(own, { recursive: true }); fs.writeFileSync(path.join(own, 'SKILL.md'), '自己的');
  skills.ensure('claude');
  assert.equal(fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8'), '自己的');
});

test('各 Claw 装到它自己读的目录：GLM → ~/.claude/skills，iFlow、CodeBuddy 各自的目录，其余 → ~/.agents/skills', () => {
  assert.equal(skills.targetOf('glm'), 'claude');
  assert.equal(skills.targetOf('iflow'), 'iflow');
  assert.equal(skills.targetOf('codebuddy'), 'codebuddy');
  for (const c of ['deepseek', 'kimi', 'qwen', 'codex', 'openclaw', 'minimax', 'qoder', 'copilot', 'gemini']) assert.equal(skills.targetOf(c), 'agents');
  skills.ensure('iflow');
  assert.ok(fs.existsSync(path.join(home, '.iflow', 'skills', 'claw-video', 'SKILL.md')));
  skills.ensure('codebuddy');
  assert.ok(fs.existsSync(path.join(home, '.codebuddy', 'skills', 'claw-file', 'SKILL.md')));
  const all = ['claude', 'deepseek', 'opencode', 'kimi', 'qwen', 'codex', 'openclaw', 'glm', 'iflow', 'minimax', 'codebuddy', 'qoder', 'copilot', 'gemini'];
  for (const n of ['claw-file', 'claw-video', 'claw-audio', 'claw-movie', 'claw-image', 'claw-tv']) assert.deepEqual(skills.catalog().find(s => s.name === n).claws, all);
});

test('拆掉的旧技能（claclaw-media）：启动同步时删掉我们装的复制件，原位置装上接替的四个；用户自己的同名技能不碰', () => {
  const ours = path.join(home, '.codebuddy', 'skills', 'claclaw-media');
  fs.rmSync(path.join(home, '.codebuddy', 'skills'), { recursive: true, force: true });
  fs.mkdirSync(ours, { recursive: true });
  fs.writeFileSync(path.join(ours, 'SKILL.md'), '旧的'); fs.writeFileSync(path.join(ours, '.claclaw-skill'), '{"from":"claclaw"}');
  const theirs = path.join(home, '.iflow', 'skills', 'claclaw-media');
  fs.mkdirSync(theirs, { recursive: true }); fs.writeFileSync(path.join(theirs, 'SKILL.md'), '自己的');
  skills.syncInstalled();
  assert.ok(!fs.existsSync(ours));
  for (const n of skills.RETIRED['claclaw-media']) assert.equal(skills.stateAt(n, 'codebuddy'), 'ours');
  assert.equal(fs.readFileSync(path.join(theirs, 'SKILL.md'), 'utf8'), '自己的');
});

test('影音技能都有命令入口，并按 group 分组', () => {
  for (const n of ['claw-video', 'claw-audio', 'claw-movie', 'claw-image']) {
    const s = skills.catalog().find(x => x.name === n);
    assert.equal(s.group, '影音');
    assert.ok(fs.existsSync(path.join(import.meta.dirname, '..', 'skills', n, n.replace('claw-', '') + '.mjs')));
  }
});

test('claw-music：纯音频技能登记在影音组，有命令入口', () => {
  const s = skills.catalog().find(x => x.name === 'claw-music');
  assert.equal(s.group, '影音');
  assert.ok(fs.existsSync(path.join(import.meta.dirname, '..', 'skills', 'claw-music', 'music.mjs')));
});

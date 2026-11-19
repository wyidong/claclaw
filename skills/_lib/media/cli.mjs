// 影音技能的入口共用：把技能自己的命令翻译成引擎的命令，再交给 engine.mjs 跑。
// 各技能的命令都是「技能名 "关键词"」做默认动作，少数子命令放第一个词（见各技能的 SKILL.md）。
// 技能的命令由 ~/.claclaw/bin/claw-<名> 跑仓库里的脚本，所以这里用相对路径引公共代码没问题
// （装到各 Claw 目录的复制件只给 AI 看 SKILL.md，不直接跑）。
import { fileURLToPath } from 'node:url';
export async function run(args, usage) {
  if (!args.length || /^(-h|--help|help)$/.test(args.at(-1) ?? '')) { console.error(usage); process.exit(1); }
  process.env.CLACLAW_MEDIA_USAGE = usage;
  process.argv = [process.argv[0], fileURLToPath(new URL('./engine.mjs', import.meta.url)), ...args];
  await import('./engine.mjs');
}
// argv 里第一个词是子命令（subs 里有的）就拆出来，否则是默认动作
export function split(argv, subs) {
  return subs.includes(argv[0]) ? [argv[0], argv.slice(1)] : ['', argv];
}

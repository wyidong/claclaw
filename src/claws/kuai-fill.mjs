// kuAi 的「填空」（能力档 L1）：模型跟不住「自己决定用哪个技能、自己写命令」时，换成程序来编排——
// 程序按关键词认出用户想用哪个技能 → 模型只把参数填进固定的 JSON → 程序校验、拼命令、跑技能 → 结果由程序贴出来。
// 让小模型自己判断「用不用」不可靠（实测 qwen3:1.7b：不给例子全答不用，给了例子全答用），所以用不用由关键词和校验定，模型说的只当否决票。
// 纯函数，不碰磁盘和网络；kuai-agent.mjs 用。技能的填空定义写在 skills/kuai.json，每个技能一条 { brief, fill }：
//   brief     工具档（L2 以上）技能清单里的一句话
//   fill.what      这个功能一句话，接在「claclaw 可以替你」后面
//   fill.when      用户的话像这样才走这个技能（正则）；fill.not：像这样就不走（多半是在提问，或者是别的技能的事）
//   fill.slots     要填的参数 { 名字: { desc, enum?, match?, map? } }
//                    普通的：模型从用户的话里取；取出来的必须是用户原话里的一段（照抄例子的、编出来的都不要），match 是还要符合的正则
//                    enum：只能是这几个值之一，没说就留空
//                    map：不问模型，程序按关键词定（[[正则, 值], …]，从上往下第一个对上的；都对不上就是空）
//   fill.need      必须有的参数，写成 ["song|artist"] 是几个里有一个就行；缺了就当不用
//   fill.args      命令参数的模板：["{song} {artist}", ["--max", "{max}"]]。带 {参数} 的那一项填出来是空的就不要；数组是一组，组里有空的整组不要
//   fill.else      参数不够时改跑的命令参数（没有就不跑，照常问答）；fill.elseLead 是这时结果前面的那句话
//   fill.examples  给模型看的例子 [[用户的话, {参数}], …]；参数写 null 是「不用」的例子
//   fill.lead      结果前面的一句话（可以带 {参数}）
//   fill.paste     结果怎么贴：不写 = 原样（带制表符的链接行整理成一行一条）；'files' = 每行第一列是文件路径
//   fill.raw       true = 技能的输出本身就是给用户看的话：没跑成也原样贴出来，不交给模型转述（小模型转述会走样；装软件这类要照实说）

const re = v => { try { return v ? new RegExp(v, 'i') : null; } catch { return null; } };
const HOLE = /\{(\w+)\}/g, hasHole = t => /\{\w+\}/.test(t);

// meta：skills/kuai.json 的内容；has(name)：这个技能在不在（没装的不要）
export function loadFills(meta, has = () => true) {
  const out = [];
  for (const [name, x] of Object.entries(meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {})) {
    const f = x?.fill, when = re(f?.when);
    if (!f || !when || !Array.isArray(f.args) || !has(name)) continue;
    const slots = Object.entries(f.slots || {}).map(([key, v]) => ({ key, desc: String(v?.desc || key), enum: Array.isArray(v?.enum) ? v.enum.map(String) : null, match: re(v?.match),
      map: Array.isArray(v?.map) ? v.map.map(p => [re(p?.[0]), String(p?.[1] ?? '')]).filter(p => p[0]) : null }));
    out.push({ name, what: String(f.what || name), when, not: re(f.not), slots, need: Array.isArray(f.need) ? f.need.map(String) : [], args: f.args, else: Array.isArray(f.else) ? f.else.map(String) : null,
      examples: (Array.isArray(f.examples) ? f.examples : []).filter(e => Array.isArray(e) && typeof e[0] === 'string'), lead: String(f.lead || ''), elseLead: String(f.elseLead || ''), paste: String(f.paste || ''), raw: f.raw === true });
  }
  return out;
}

// 用户这句话走哪个技能：按 kuai.json 里的顺序，第一个对上的。太长的（不是一句话的事）、多行的不走
export function routeFill(fills, text) {
  const t = String(text || '').trim();
  if (!t || t.length > 120 || t.includes('\n')) return null;
  return fills.find(f => f.when.test(t) && !(f.not && f.not.test(t))) || null;
}

// 要问模型的参数（map 的由程序定）
export const askSlots = f => f.slots.filter(s => !s.map);

// 约束输出用的 JSON Schema：每个参数一个字符串（enum 的多一个空值），最后是 use
export function fillSchema(f) {
  const props = {};
  for (const s of askSlots(f)) props[s.key] = s.enum ? { type: 'string', enum: [...s.enum, ''] } : { type: 'string' };
  props.use = { type: 'boolean' };
  return { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false };
}

// 接在用户那句话后面的填空说明。前面的系统提示和历史不动（Ollama 能复用已处理的前缀），说明放在最后
export function fillAsk(f) {
  const ask = askSlots(f);
  const row = o => JSON.stringify({ ...Object.fromEntries(ask.map(s => [s.key, String(o?.[s.key] ?? '')])), use: !!o });
  return `\n\n———\n[claclaw] claclaw 可以替你${f.what}。从上面用户的话里取出参数，只输出一个 JSON：`
    + ask.map(s => `${s.key} 写${s.desc}${s.enum ? '（只能是 ' + s.enum.join(' / ') + '，没说就留空）' : ''}`).join('；')
    + `；use 写用户是不是现在就要这样做（只是提问、闲聊就写 false）。照用户的原话取，不要改写、不要编。`
    + f.examples.map(e => `\n例：「${e[0]}」→ ${row(e[1])}`).join('');
}

// 模型填回来的（raw）→ { use, slots, said }；JSON 都认不出来返回 null。
// 校验：普通参数必须是用户原话里的一段（不能是整句话）、不能以 - 开头（不让它变成命令的选项）；enum 的必须在表里；不合格的当没填
export function parseFill(f, raw, text) {
  const m = /\{[\s\S]*\}/.exec(String(raw || ''));
  let o = null;
  if (m) { try { o = JSON.parse(m[0]); } catch {} }
  const ask = askSlots(f);
  if (ask.length && (!o || typeof o !== 'object' || Array.isArray(o))) return null;
  o ||= {};
  const norm = v => String(v ?? '').replace(/\s+/g, '').toLowerCase(), src = norm(text), slots = {};
  for (const s of f.slots) {
    if (s.map) { slots[s.key] = s.map.find(p => p[0].test(text))?.[1] || ''; continue; }
    let v = typeof o[s.key] === 'string' || typeof o[s.key] === 'number' ? String(o[s.key]).trim() : '';
    if (v && s.enum) v = s.enum.includes(v) ? v : '';
    else if (v && (v.startsWith('-') || !src.includes(norm(v)) || (norm(v) === src && src.length > 4) || (s.match && !s.match.test(v)))) v = '';
    slots[s.key] = v;
  }
  return { use: o.use !== false && enough(f, slots), slots, said: typeof o.use === 'boolean' ? o.use : null };
}
// 必须有的参数都有了没有（"a|b" 是有一个就行）
export const enough = (f, slots) => f.need.every(n => n.split('|').some(k => slots[k]));

// 参数 → 命令的参数表（不经 shell，原样传给技能脚本）
export function fillArgs(f, slots, tpl = f.args) {
  const sub = t => String(t).replace(HOLE, (_, k) => slots[k] || '').replace(/\s+/g, ' ').trim();
  const out = [];
  for (const a of tpl) {
    const group = Array.isArray(a) ? a.map(String) : [String(a)], vals = group.map(sub);
    if (group.every((t, i) => !hasHole(t) || vals[i])) out.push(...vals);
  }
  return out;
}
// 给人看的命令行（工具卡片、解剖页）
export const fillLine = (name, args) => [name, ...args.map(a => /^[\w./:@,=+-]+$/.test(a) ? a : JSON.stringify(a))].join(' ');
export const fillLead = (f, slots) => f.lead.replace(HOLE, (_, k) => slots[k] || '').trim();

// 技能的输出 → 贴进回复的样子
export function pasteOut(f, out) {
  const t = String(out || '').trim();
  if (f.paste === 'files') return t.split('\n').map(l => l.split('\t')[0].trim()).filter(Boolean).map(p => '`' + p + '`').join('\n');
  if (t.includes('```')) return t;   // 卡片代码块（tv、shop、theme）：整块原样
  const tidy = l => l.split(/\t+/).map(x => x.trim()).filter(Boolean).join(' · ');
  const isLink = l => /^\[[^\]]+\]\([^)]+\)/.test(l.trim());
  const rows = t.split('\n'), many = rows.filter(isLink).length > 1;
  let n = 0;
  return rows.map(l => isLink(l) ? (many ? ++n + '. ' : '') + tidy(l) : tidy(l)).join('\n');
}

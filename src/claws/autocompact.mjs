// 上下文自动压缩：每轮结束后，上下文超过设置里的线（k token；0 = 从不，默认）就自动发一次 /compact。
// Claude 会话（server.mjs 的 Runner）和支持 /compact 的 ACP 会话（acp.mjs，目前是 DeepSeek）共用。
// 压过一次没降下来（比如压缩失败）：同一个大小不再反复压，等上下文再长了才再试；压缩成功（收到压缩完成）就清掉这个记号
export const AUTO_COMPACT = { k: () => 0 };   // server.mjs 注入：读 data/settings.json 的 autoCompactK
export const AUTO_COMPACT_CHOICES = [0, 100, 150, 200, 300];

export function autoCompactDue(r) {
  const k = AUTO_COMPACT.k(), ctx = Number(r.ctx) || 0;
  if (!k || ctx < k * 1000) return false;
  if (r.autoCompactAt && ctx <= r.autoCompactAt) return false;
  return true;
}
const kk = n => Math.round(n / 1000) + 'k';
export function autoCompactRun(r) {
  r.autoCompactAt = Number(r.ctx) || 0;
  r.emit({ t: 'sys', text: '上下文到了 ' + kk(r.ctx) + '，超过自动压缩线 ' + AUTO_COMPACT.k() + 'k，开始自动压缩' });
  r.emit({ t: 'ctx.auto' });   // 网页：标题栏显示「压缩中」
  const ok = r.send('/compact');
  if (ok) r.emit({ t: 'busy', on: true });   // 不是网页发起的一轮：告诉网页在干活
  return ok;
}

// 请求体读取：按字节算大小，分块攒成 Buffer，最后一次性解码。
// 原来 server.mjs 里是 b += c 逐块解码再拼接：中文这类多字节字符恰好跨在分块边界上时会变成乱码。
// 单拎成一个小模块是为了能直接写单测（跨分块的多字节字符）。
export function readBody(req, max = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', c => {
      bytes += c.length;                 // Buffer 的 length 就是字节数
      if (bytes > max) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
// 读 JSON 请求体：读不到、太大或不是 JSON 都返回 fallback（默认空对象）
export async function jsonBody(req, max = 4096, fallback = {}) {
  try { return JSON.parse(await readBody(req, max)); } catch { return fallback; }
}

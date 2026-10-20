"""claclaw 的微软在线语音（Edge「大声朗读」用的那套自然语音）合成助手。

常驻进程：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 结果（音频 base64，MP3）。
  {"id": 1, "op": "voices"}                                  → {"id": 1, "ok": true, "voices": [{"name","gender","locale"}]}
  {"id": 2, "op": "say", "text": "…", "voice": "zh-CN-XiaoyiNeural", "rate": "+10%"} → {"id": 2, "ok": true, "audio": "<base64>"}
  {"id": 3, "op": "warm"}                                    → 先把连接建好（打开朗读时调一下，第一句就不用等握手）
依赖 edge-tts（pip 包，借用微软 Edge 的在线朗读服务，不是官方开放接口，微软改了可能失效，升级这个包通常就能修好）。

为什么自己管连接：edge-tts 每念一句都新建一条加密连接，光握手就要 1～1.5 秒；
这里保持 2 条长连接轮流用，一句只剩合成本身的时间。连接断了就重连重试一次。
"""
import asyncio
import base64
import json
import sys
from xml.sax.saxutils import escape

import aiohttp
import edge_tts
from edge_tts import communicate as ec
from edge_tts.constants import SEC_MS_GEC_VERSION, WSS_HEADERS, WSS_URL
from edge_tts.drm import DRM

SSL = getattr(ec, "_SSL_CTX", None)
CONFIG = (
    "Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n"
    '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},'
    '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
)


class Conn:
    def __init__(self):
        self.session = None
        self.ws = None
        self.lock = asyncio.Lock()

    async def open(self):
        await self.close()
        self.session = aiohttp.ClientSession(trust_env=True)
        self.ws = await self.session.ws_connect(
            f"{WSS_URL}&ConnectionId={ec.connect_id()}&Sec-MS-GEC={DRM.generate_sec_ms_gec()}&Sec-MS-GEC-Version={SEC_MS_GEC_VERSION}",
            compress=15, headers=DRM.headers_with_muid(WSS_HEADERS), ssl=SSL, heartbeat=20,
        )
        await self.ws.send_str(f"X-Timestamp:{ec.date_to_string()}\r\n" + CONFIG)

    async def close(self):
        try:
            if self.ws is not None:
                await self.ws.close()
            if self.session is not None:
                await self.session.close()
        except Exception:  # noqa: BLE001
            pass
        self.ws = self.session = None

    async def synth(self, text, voice, rate):
        ssml = (
            "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>"
            f"<voice name='{voice}'><prosody pitch='+0Hz' rate='{rate}' volume='+0%'>{escape(text)}</prosody></voice></speak>"
        )
        await self.ws.send_str(ec.ssml_headers_plus_data(ec.connect_id(), ec.date_to_string(), ssml))
        buf = bytearray()
        async for msg in self.ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                if "Path:turn.end" in msg.data:
                    break
            elif msg.type == aiohttp.WSMsgType.BINARY:
                hl = int.from_bytes(msg.data[:2], "big")
                if b"Path:audio" in msg.data[2:2 + hl]:
                    buf += msg.data[2 + hl:]
            else:
                raise ConnectionError("连接断了")
        else:
            raise ConnectionError("连接断了")
        if not buf:
            raise RuntimeError("没有收到声音")
        return bytes(buf)


POOL = [Conn(), Conn()]
_next = 0


async def say(req):
    global _next
    conn = POOL[_next % len(POOL)]
    _next += 1
    async with conn.lock:
        for attempt in range(2):
            try:
                if conn.ws is None or conn.ws.closed:
                    await conn.open()
                audio = await asyncio.wait_for(conn.synth(req["text"], req["voice"], req.get("rate", "+0%")), 20)
                return {"audio": base64.b64encode(audio).decode()}
            except Exception:  # noqa: BLE001
                await conn.close()
                if attempt:
                    raise


async def warm(_req):
    async def one(c):
        async with c.lock:
            if c.ws is None or c.ws.closed:
                await c.open()
    await asyncio.gather(*(one(c) for c in POOL), return_exceptions=True)
    return {}


async def voices(_req):
    vs = await edge_tts.list_voices()
    return {"voices": [{"name": v["ShortName"], "gender": v.get("Gender", ""), "locale": v.get("Locale", "")}
                       for v in vs if v.get("Locale", "").startswith("zh-")]}


OPS = {"say": say, "voices": voices, "warm": warm}


async def handle(line, out_lock):
    try:
        req = json.loads(line)
    except Exception:  # noqa: BLE001
        return
    try:
        res = await OPS.get(req.get("op"), say)(req)
        res.update({"id": req.get("id"), "ok": True})
    except Exception as e:  # noqa: BLE001 —— 任何失败都回给调用方
        res = {"id": req.get("id"), "ok": False, "error": str(e)[:300] or type(e).__name__}
    async with out_lock:
        sys.stdout.write(json.dumps(res) + "\n")
        sys.stdout.flush()


async def main():
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=1 << 20)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    out_lock = asyncio.Lock()
    tasks = set()
    while True:
        line = await reader.readline()
        if not line:
            break
        t = asyncio.create_task(handle(line.decode("utf-8", "replace"), out_lock))
        tasks.add(t)
        t.add_done_callback(tasks.discard)
    if tasks:
        await asyncio.gather(*tasks)
    for c in POOL:
        await c.close()


asyncio.run(main())

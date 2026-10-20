"""claclaw 的微软在线语音（Edge「大声朗读」用的那套自然语音）合成助手。

常驻进程：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 结果（音频 base64，MP3）。
  {"id": 1, "op": "voices"}                                  → {"id": 1, "ok": true, "voices": [{"name","gender","locale"}]}
  {"id": 2, "op": "say", "text": "…", "voice": "zh-CN-XiaoyiNeural", "rate": "+10%"} → {"id": 2, "ok": true, "audio": "<base64>"}
依赖 edge-tts（pip 包，借用微软 Edge 的在线朗读服务，不是官方开放接口，微软改了可能失效，升级这个包通常就能修好）。
"""
import asyncio
import base64
import json
import sys

import edge_tts


async def say(req):
    buf = bytearray()
    async for ch in edge_tts.Communicate(req["text"], req["voice"], rate=req.get("rate", "+0%")).stream():
        if ch["type"] == "audio":
            buf += ch["data"]
    return {"audio": base64.b64encode(bytes(buf)).decode()}


async def voices(_req):
    vs = await edge_tts.list_voices()
    return {"voices": [{"name": v["ShortName"], "gender": v.get("Gender", ""), "locale": v.get("Locale", "")}
                       for v in vs if v.get("Locale", "").startswith("zh-")]}


async def handle(line, out_lock):
    try:
        req = json.loads(line)
    except Exception:
        return
    try:
        res = await (voices(req) if req.get("op") == "voices" else say(req))
        res.update({"id": req.get("id"), "ok": True})
    except Exception as e:  # noqa: BLE001 —— 任何失败都回给调用方
        res = {"id": req.get("id"), "ok": False, "error": str(e)[:300]}
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


asyncio.run(main())

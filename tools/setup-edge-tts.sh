#!/bin/bash
# 装上微软在线语音（晓伊、晓晓、云希…）：在 claclaw 的 data 目录里建一个独立的 Python 环境，装 edge-tts。
# 再跑一次就是升级（微软改了接口导致念不出来时，升级通常能修好）。
set -e
cd "$(dirname "$0")/.."
DATA="${CLACLAW_DATA:-data}"
mkdir -p "$DATA/edge-tts"
[ -x "$DATA/edge-tts/venv/bin/python" ] || python3 -m venv "$DATA/edge-tts/venv"
"$DATA/edge-tts/venv/bin/pip" install -q --upgrade edge-tts
echo "装好了：$("$DATA/edge-tts/venv/bin/python" -c 'import edge_tts,sys;print("edge-tts", edge_tts.__version__)')"

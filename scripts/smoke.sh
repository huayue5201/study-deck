#!/usr/bin/env bash
# 冒烟测试：不依赖前端，直接打后端 API。
# 从握手文件里读端口和令牌，所以桌面版/CLI 版都能用：
#   ./scripts/smoke.sh                     # macOS 默认数据目录
#   STUDYDECK_DATA=/tmp/sd ./scripts/smoke.sh
set -euo pipefail

DATA="${STUDYDECK_DATA:-$HOME/Library/Application Support/dev.studydeck.app}"
HANDSHAKE="$(cat "$DATA/port" 2>/dev/null || true)"
if [ -z "$HANDSHAKE" ]; then
  echo "找不到 $DATA/port —— 应用没在跑？" >&2
  exit 1
fi

PORT=$(printf '%s' "$HANDSHAKE" | python3 -c 'import sys,json;print(json.load(sys.stdin)["port"])')
TOKEN=$(printf '%s' "$HANDSHAKE" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')
API=$(printf '%s' "$HANDSHAKE" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("api",1))')
BASE="http://127.0.0.1:$PORT"
AUTH=()
if [ -n "$TOKEN" ]; then AUTH=(-H "Authorization: Bearer $TOKEN"); fi

echo "== handshake: api=$API port=$PORT token=${TOKEN:+set} =="

echo "== health =="
curl -sS "$BASE/api/health" | grep -q '"ok":true' && echo "health: ok"

echo "== 未授权访问应被拒 =="
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/sessions")
[ "$CODE" = "401" ] && echo "401: ok" || { echo "expected 401, got $CODE" >&2; exit 1; }

echo "== 未知 /api 路径应 404 =="
CODE=$(curl -sS "${AUTH[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/nope")
[ "$CODE" = "404" ] && echo "404: ok" || { echo "expected 404, got $CODE" >&2; exit 1; }

echo "== create session =="
SID=$(curl -sS "${AUTH[@]}" -X POST "$BASE/api/sessions" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "session=$SID"

echo "== main turn (SSE) =="
curl -sS "${AUTH[@]}" -N -m 30 -D /tmp/smoke-headers.txt -X POST "$BASE/api/chat" \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$SID\",\"mode\":\"main\",\"text\":\"讲讲采样定理\"}" > /tmp/smoke-main.sse || true
grep -c '"type":"delta"' /tmp/smoke-main.sse | xargs -I{} echo "delta frames: {}"
grep -q '"type":"turn_started"' /tmp/smoke-main.sse && echo "turn_started: ok"
grep -q '"type":"end"' /tmp/smoke-main.sse && echo "end: ok"
grep -qi '^x-deck-turn:' /tmp/smoke-headers.txt && echo "x-deck-turn header: ok"
TURN=$(grep -i '^x-deck-turn:' /tmp/smoke-headers.txt | tr -d '\r' | awk '{print $2}')
grep -q '"type":"assistant_start"' /tmp/smoke-main.sse && echo "assistant_start: ok"

echo "== 轮次登记 =="
curl -sS "${AUTH[@]}" "$BASE/api/turns/$TURN" | python3 -c '
import sys,json
d=json.load(sys.stdin)
print("turn state:", d["state"], "seq:", d["seq"])
assert d["state"] in ("ok","running","error","cancelled")
'

echo "== 回放（?since=0） =="
curl -sS "${AUTH[@]}" -N -m 5 "$BASE/api/turns/$TURN/events?since=0" | head -3 | grep -q '"type"' && echo "replay: ok"

echo "== 会话状态 =="
curl -sS "${AUTH[@]}" "$BASE/api/sessions/$SID" | python3 -c '
import sys,json
d=json.load(sys.stdin)
print("messages:", len(d["messages"]), "status:", [m.get("status") for m in d["messages"]])
'

echo "== glossary =="
curl -sS "${AUTH[@]}" -X POST "$BASE/api/glossary" -H 'Content-Type: application/json' \
  -d '{"term":"采样率","gist":"离散化所需的最低采样频率","depth":"can_tune"}' | grep -q '"term":"采样率"'
curl -sS "${AUTH[@]}" "$BASE/api/glossary?q=采样" | grep -q '采样率'
echo "glossary: ok"

echo "ALL OK"

#!/usr/bin/env bash
# ラズパイから大会結果を取得し、変化があればコミットして push する。
# Node-RED の exec ノードから呼ぶ想定。
#
# 終了コード:
#   0 = 正常（更新の有無は問わない）
#   1 = 取得に失敗（ボット対策に当たった等）
set -euo pipefail

cd "$(dirname "$0")/.."

# 他方（GitHub Actions のカード更新）が先に push している場合に備えて先に取り込む
git fetch -q origin main
git rebase -q origin/main || { echo "rebase に失敗した。手動で確認すること。"; exit 1; }

npm run --silent events

if git diff --quiet -- data/events.json data/events-state.json public/events.json; then
  echo "更新なし"
  exit 0
fi

count=$(node -p "require('./data/events.json').length")
git add data/events.json data/events-state.json public/events.json
git commit -q -m "大会結果を更新（全 ${count} 件）"
git push -q origin HEAD:main
echo "更新して push した（全 ${count} 件）"

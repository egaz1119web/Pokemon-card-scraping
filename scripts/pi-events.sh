#!/usr/bin/env bash
# ラズパイから大会結果を取得し、変化があればコミットして push する。
# Node-RED の exec ノードから呼ぶ想定。
#
# 最後に __STATUS__ 行を出す（既存の sf6checker-lp と同じ作法）。
# Node-RED 側はこれを読んで通知の要否を決める。
#
# 取得 → コミット → 取り込み → push の順で行う。
# 先に rebase すると、生成したデータが未コミットのままで rebase が失敗する。
#
# 終了コード:
#   0  正常（更新の有無は問わない）
#   30 取得に失敗（ボット対策に当たった等）
#   40 GitHub への反映に失敗
set -uo pipefail
cd "$(dirname "$0")/.."

DATA_FILES=(data/events.json data/events-state.json public/events.json)

status() { echo "__STATUS__ {\"updated\":$1,\"count\":$2,\"reason\":\"$3\"}"; }

if ! npm run --silent events; then
  status false 0 "大会結果の取得に失敗"
  exit 30
fi

count=$(node -p "require('./data/events.json').length")

if git diff --quiet -- "${DATA_FILES[@]}"; then
  echo "更新なし"
  status false "$count" ""
  exit 0
fi

git add "${DATA_FILES[@]}"
git commit -q -m "大会結果を更新（全 ${count} 件）"

# カード側（GitHub Actions）が先に push している場合に備えて取り込む。
# 触るファイルが分かれているので通常は素通りする。
if ! git fetch -q origin main || ! git -c rebase.autoStash=true rebase -q origin/main; then
  git rebase --abort 2>/dev/null || true
  status false "$count" "リモートの取り込みに失敗"
  exit 40
fi

if ! git push -q origin HEAD:main; then
  status false "$count" "push に失敗"
  exit 40
fi

echo "更新して push した（全 ${count} 件）"
status true "$count" ""

#!/bin/bash
PROJECTS=(
  "nesquena/hermes-webui"
  "EKKOLearnAI/hermes-web-ui"
  "outsourc-e/hermes-workspace"
  "fathah/hermes-desktop"
  "dodo-reach/hermes-desktop"
  "xaspx/hermes-control-interface"
  "clawvader-tech/hermes-telegram-miniapp"
  "pyrate-llama/hermes-ui"
  "aivrar/portable-hermes-agent"
  "sanchomuzax/hermes-webui"
  "Euraika-Labs/pan-ui"
)
for proj in "${PROJECTS[@]}"; do
  slug=$(echo "$proj" | tr '/' '_')
  echo "=== $proj ==="
  firecrawl scrape "https://hermesatlas.com/projects/$proj" --only-main-content -o ".firecrawl/hermes-projects/atlas/$slug.md" &
  firecrawl scrape "https://github.com/$proj" --only-main-content -o ".firecrawl/hermes-projects/github/$slug.md" &
  wait
done

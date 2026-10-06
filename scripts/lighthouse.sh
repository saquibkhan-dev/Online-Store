#!/bin/sh
# Real Lighthouse audit (needs Chrome/Chromium installed). Usage: BASE_URL=https://shop.example.com sh scripts/lighthouse.sh
# Fails if any category drops below the budget. Reports are written to ./lighthouse-reports/.
set -eu
BASE_URL="${BASE_URL:-http://localhost:8080}"
mkdir -p lighthouse-reports
for path in / /register /privacy; do
  name="$(echo "$path" | tr '/' '_')"; [ "$name" = "_" ] && name="_home"
  npx --yes lighthouse "$BASE_URL$path" --quiet --chrome-flags="--headless=new --no-sandbox" \
    --only-categories=performance,accessibility,best-practices,seo --output=json --output=html \
    --output-path="lighthouse-reports/$name" >/dev/null
  node -e '
    const r = require("./lighthouse-reports/'"$name"'.report.json");
    const s = Object.fromEntries(Object.entries(r.categories).map(([k, v]) => [k, Math.round(v.score * 100)]));
    console.log("'"$path"'", JSON.stringify(s));
    const min = { performance: 85, accessibility: 95, "best-practices": 95, seo: 95 };
    const bad = Object.entries(min).filter(([k, v]) => s[k] < v);
    if (bad.length) { console.error("below budget:", bad.map(([k]) => k).join(", ")); process.exit(1); }
  '
done

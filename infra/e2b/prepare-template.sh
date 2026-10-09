#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
assets=${LEGALWORK_TEMPLATE_ASSETS:-"$root/tmp/e2b-template"}
mkdir -p "$assets"
cd "$root"
pnpm --filter legalwork-server build
pnpm --filter legalwork-server exec bun build src/cli.ts --target bun \
  --external cpu-features --external @napi-rs/canvas --external onnxruntime-node \
  --external better-sqlite3 --outfile "$assets/cli.js"
cp infra/e2b/server-launcher.sh "$assets/legalwork-server"
cp -R apps/server/dist/opencode-plugins "$assets/"
cp infra/e2b/start-worker.sh "$assets/"
cp -R apps/server/resources/ocr "$assets/"
docker build --platform linux/amd64 -f infra/e2b/native/Dockerfile \
  --output "type=local,dest=$assets/native" infra/e2b/native
tar -czf "$assets/native-deps.tar.gz" -C "$assets/native" node_modules
curl -fsSL https://github.com/anomalyco/opencode/releases/download/v1.18.35/opencode-linux-x64-baseline.tar.gz -o "$assets/opencode.tar.gz"
echo "90c97d4a24d36437bce36f27195c9cd2e0b70ed037a04d1c6a6740eb246c2a73  $assets/opencode.tar.gz" | shasum -a 256 -c -
tar -xzf "$assets/opencode.tar.gz" -C "$assets"
test -x "$assets/opencode"
curl -fsSL https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64-baseline.zip -o "$assets/bun.zip"
echo "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7  $assets/bun.zip" | shasum -a 256 -c -
unzip -oq "$assets/bun.zip" -d "$assets/bun-runtime"
cp "$assets/bun-runtime/bun-linux-x64-baseline/bun" "$assets/bun"
echo "Template assets ready in $assets"

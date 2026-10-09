FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS dependencies
WORKDIR /native
RUN corepack enable && corepack prepare pnpm@11.4.0 --activate
COPY package.json pnpm-lock.yaml ./
# ONNX ships CPU libraries; skip its optional CUDA download. The LegalWork
# Bun runtime uses bun:sqlite, so a Node-ABI sqlite addon is unnecessary.
RUN pnpm install --ignore-scripts --frozen-lockfile
FROM scratch
COPY --from=dependencies /native/node_modules /node_modules
COPY --from=dependencies /native/pnpm-lock.yaml /pnpm-lock.yaml

FROM node:26.9.0-bookworm-slim@sha256:582460f614631b59b824ac6020533b9bf339c7fdf3a6d7db31abb6b4065f0212
RUN apt-get update && apt-get install -y --no-install-recommends iptables util-linux ca-certificates && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 10001 chat && useradd -u 10001 -g chat -M -d /data/home chat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY public ./public
COPY profile ./profile
COPY --chmod=755 scripts ./scripts
COPY test ./test
ENV HOME=/data/home PI_CODING_AGENT_DIR=/data/profile NODE_ENV=production
ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["node", "src/server.mjs"]

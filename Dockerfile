# BrownHub Haul — the whole app is Node 20+ and zero dependencies.
# Build:  docker build -t brownhub-haul .
# Run:    docker run -d -p 8420:8420 -v haul-data:/data brownhub-haul
#
# /data is the only state: shipments.json, secret.key, brand.json and photos/.
# Mount a volume there or every redeploy starts with an empty depot.

FROM node:24-alpine

WORKDIR /app
COPY . .

# The container listens on all interfaces; a platform proxy in front of it sets
# TRUST_PROXY=1 so the PIN and booking buckets see the real client, not the proxy.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8420 \
    DB=/data/shipments.json \
    PHOTOS=/data/photos \
    BRAND_CACHE=/data/brand.json

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8420

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:8420/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]

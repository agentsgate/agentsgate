# ─── Stage 1: Builder ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files and install ALL dependencies (including dev, needed for build)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and build
COPY tsup.config.ts tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built artifacts from builder stage
COPY --from=builder /app/dist ./dist

# Create data directory for SQLite DB and shadow git repo
RUN mkdir -p /app/data

# Expose dashboard API port and MCP proxy port
EXPOSE 3000
EXPOSE 3100

# Persistent volume for SQLite DB and shadow git repo
VOLUME ["/app/data"]

# Health check using wget (available on alpine without extra installs)
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Create non-root user
RUN addgroup -g 1001 -S agentsgate && adduser -u 1001 -S agentsgate -G agentsgate

# Give ownership of data directory to non-root user
RUN chown -R agentsgate:agentsgate /app/data

USER agentsgate

CMD ["node", "dist/cli.js", "start", "--port", "3000"]

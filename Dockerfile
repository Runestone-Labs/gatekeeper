FROM node:20-alpine

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 gatekeeper && \
    adduser -u 1001 -G gatekeeper -s /bin/sh -D gatekeeper

# Install dependencies (including tsx from devDependencies)
COPY package*.json ./
RUN npm ci

# Copy source code
COPY src ./src
COPY policy.example.yaml ./policy.yaml
COPY drizzle.config.ts ./drizzle.config.ts
COPY drizzle ./drizzle

# Create data directories with correct ownership
RUN mkdir -p data/approvals data/audit && \
    chown -R gatekeeper:gatekeeper /app

USER gatekeeper
EXPOSE 3847

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3847/health || exit 1

CMD ["npm", "start"]

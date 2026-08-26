# Workel MCP Server (remote transport) — Azure App Service image.
#
# Builds `src/remote.ts`, the Streamable HTTP entry Claude connects to. The
# stdio entry (`dist/index.js`, what `npx @workel/mcp` runs) ships in the same
# image but is not what this container starts.
#
# The npm package and this image are built from the same source on purpose:
# one server implementation, two transports, so a tool can never behave
# differently depending on how a user reached it.
FROM node:22-alpine AS base

WORKDIR /app

# Dev dependencies are needed here — the build is TypeScript.
COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

# Production stage: no dev dependencies, no sources, just the built output.
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY --from=base /app/dist ./dist
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/package*.json ./

# Must match WEBSITES_PORT in the Terraform app settings and remote.ts's
# DEFAULT_REMOTE_PORT. All three are the same number by necessity: App Service
# routes to WEBSITES_PORT, and a mismatch surfaces only as an unreachable
# container.
EXPOSE 8787

# Hits the same unauthenticated liveness path App Service polls.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8787/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "dist/remote.js"]

# dashboard/Dockerfile: the dashboard's image. Built by Cloud Build from the repo root at a release
# (dashboard/cloudbuild.json), so the dashboard can import the agent libraries it shares. Only what the
# dashboard needs is copied in: its own code, config/ and the agent packages it imports.

FROM node:24-slim AS build
WORKDIR /src
ENV NEXT_TELEMETRY_DISABLED=1
COPY dashboard/package.json dashboard/package-lock.json dashboard/
RUN npm ci --prefix dashboard
COPY config config
COPY agent/auth agent/auth
COPY agent/storage agent/storage
COPY agent/work agent/work
COPY agent/release agent/release
COPY dashboard dashboard
RUN npm run build --prefix dashboard

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0
# The standalone server mirrors the repo layout: dashboard/server.js beside agent/ and config/.
COPY --from=build /src/dashboard/.next/standalone ./
COPY --from=build /src/dashboard/.next/static ./dashboard/.next/static
COPY --from=build /src/dashboard/public ./dashboard/public
COPY --from=build /src/config/contracts.json ./config/contracts.json
# The automatic-update job (dashboard/jobs/auto-update.mjs) runs in this image with plain Node, outside
# the Next.js server, so it needs the server modules and the agent packages they import as source. They
# use no npm package of their own.
COPY --from=build /src/dashboard/jobs ./dashboard/jobs
COPY --from=build /src/dashboard/lib/server ./dashboard/lib/server
COPY --from=build /src/agent/auth ./agent/auth
COPY --from=build /src/agent/storage ./agent/storage
COPY --from=build /src/agent/work ./agent/work
COPY --from=build /src/agent/release ./agent/release
USER node
EXPOSE 8080
CMD ["node", "dashboard/server.js"]

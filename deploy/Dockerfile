FROM oven/bun:1.4.0

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-impress poppler-utils fonts-noto-cjk fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o bun -g bun /app /data/projects
WORKDIR /app
COPY --chown=bun:bun package.json bun.lock ./
USER bun
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY --chown=bun:bun bin ./bin
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun schema ./schema
COPY --chown=bun:bun themes ./themes
COPY --chown=bun:bun templates ./templates
COPY --chown=bun:bun web ./web
COPY --chown=bun:bun deploy/start.js ./deploy/start.js
EXPOSE 7357
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e 'const host=new URL(process.env.OPENPPT_PUBLIC_ORIGIN).host; const r=await fetch("http://127.0.0.1:7357/api/health",{headers:{Host:host}}); if(!r.ok || !(await r.json()).ok) process.exit(1);'
CMD ["bun", "deploy/start.js"]

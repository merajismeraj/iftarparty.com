# IftarParty production image: one Node process, SQLite + uploads on a mounted volume at /data.
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/iftarparty.db \
    UPLOAD_DIR=/data/uploads
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY views ./views
COPY public ./public
COPY scripts ./scripts
# Runs as root: hosted volumes (e.g. Railway) mount root-owned, so a non-root user couldn't write /data.
RUN mkdir -p /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]

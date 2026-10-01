FROM node:24-alpine
WORKDIR /app
RUN npm init -y && npm pkg set type=module && npm install --omit=dev --save-exact pinets@0.10.0 && npm cache clean --force
COPY --chown=node:node apps/pine-runner/src/index.ts /app/index.ts
USER node
ENTRYPOINT ["node", "--experimental-strip-types", "/app/index.ts"]

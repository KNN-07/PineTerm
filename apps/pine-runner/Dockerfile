FROM node:24-alpine AS build
WORKDIR /src
RUN npm init -y && npm pkg set type=module license=AGPL-3.0-only && npm install --save-exact pinets@0.10.0 decimal.js@10.6.0 typescript@5.9.3 @types/node@24.19.0
COPY apps/pine-runner/src ./apps/pine-runner/src
COPY packages/contracts/src/pine.ts packages/contracts/src/market.ts ./packages/contracts/src/
RUN ./node_modules/.bin/tsc --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --rootDir /src --outDir /build apps/pine-runner/src/index.ts

FROM node:24-alpine
WORKDIR /app
RUN npm init -y && npm pkg set type=module license=AGPL-3.0-only && npm install --omit=dev --save-exact pinets@0.10.0 decimal.js@10.6.0 && npm cache clean --force
COPY --from=build --chown=node:node /build/ /app/
COPY --chown=node:node LICENSE /app/LICENSE
USER node
ENTRYPOINT ["node", "/app/apps/pine-runner/src/index.js"]

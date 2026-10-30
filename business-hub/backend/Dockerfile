FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
# ponytail: devDependencies kept because the prisma CLI (migrate deploy) is one; slim the image later.
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY package.json ./
EXPOSE 3000
# ponytail: migrations run on every start (idempotent); move to a release step once there are several replicas.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]

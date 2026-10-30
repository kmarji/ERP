# One image recipe for all four React apps: docker build -f docker/web.Dockerfile --build-arg APP=frontend --build-arg API_URL=https://api.example.com .
FROM node:22-alpine AS build
ARG APP
ARG API_URL=http://localhost:3000
WORKDIR /app
COPY ${APP}/package*.json ./
RUN npm ci
COPY ${APP}/ ./
ENV VITE_API_URL=${API_URL}
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
RUN printf 'server { listen 80; root /usr/share/nginx/html; location / { try_files $uri /index.html; } }' > /etc/nginx/conf.d/default.conf

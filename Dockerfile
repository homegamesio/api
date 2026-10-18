FROM node:24-slim

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --omit=dev && mkdir -p /var/lib/homegames-api && chown node:node /var/lib/homegames-api

COPY index.js connection-api.js connection-service.js cert-policy.js certificate-*.js ./

ENV BIND_HOST=0.0.0.0 PORT=8004
EXPOSE 8004
USER node

CMD [ "node", "index.js" ]


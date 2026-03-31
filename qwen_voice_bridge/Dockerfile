ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --production=false
COPY src/ ./src/
RUN npm run build
RUN npm prune --production

COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]

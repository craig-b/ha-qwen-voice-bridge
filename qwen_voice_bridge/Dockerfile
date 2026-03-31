ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --production=false
COPY src/ ./src/
RUN npm run build
RUN npm prune --production

COPY run.sh /etc/s6-overlay/s6-rc.d/qwen-voice-bridge/run
RUN chmod a+x /etc/s6-overlay/s6-rc.d/qwen-voice-bridge/run \
    && echo "longrun" > /etc/s6-overlay/s6-rc.d/qwen-voice-bridge/type \
    && touch /etc/s6-overlay/s6-rc.d/user/contents.d/qwen-voice-bridge

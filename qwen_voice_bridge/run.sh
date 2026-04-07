#!/usr/bin/with-contenv bashio

export SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}"
export DASHSCOPE_API_KEY="$(bashio::config 'dashscope_api_key')"
export QWEN_MODEL="$(bashio::config 'qwen_model')"
export VOICE="$(bashio::config 'voice')"
export PERSONA_PROMPT="$(bashio::config 'persona_prompt')"
export SATELLITE_PORT="$(bashio::config 'satellite_port')"
export WEB_PORT="$(bashio::config 'web_port')"
export CONVERSATION_TIMEOUT="$(bashio::config 'conversation_timeout_seconds')"
export LOG_LEVEL="$(bashio::config 'log_level')"

cd /app
exec node dist/index.js

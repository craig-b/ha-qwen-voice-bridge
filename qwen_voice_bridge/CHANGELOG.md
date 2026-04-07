## 0.1.10

- Show meaningful error messages in the web UI (e.g. DashScope close reason, not just "reconnection failed")
- Show connection phases in UI: Connecting → Connected (waiting for Qwen) → Listening
- Fix Qwen session silently hanging when DashScope closes during handshake

## 0.1.9

- Fix swallowed errors in Qwen session: log connection, close codes, and reconnect failures at visible levels

## 0.1.8

- Fix WebSocket URL missing trailing slash for ingress proxy

## 0.1.7

- Fix WebSocket handling for ingress proxy (use noServer mode)
- Add request logging for web server

## 0.1.6

- Enable HA ingress for web UI (Open Web UI button, Nabu Casa support)

## 0.1.5

- Add web audio client for browser-based testing
- Add pluggable transport layer (TCP + WebSocket)

## 0.1.4

- Fix external_components ref and refresh

## 0.1.3

- Use lambda for wake word trigger

## 0.1.2

- Fix action registration with Parented pattern

## 0.1.1

- Use ESPHome action pattern for wake word integration

## 0.1.0

- Initial release

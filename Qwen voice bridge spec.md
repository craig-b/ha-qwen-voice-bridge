# Qwen Voice Bridge — Technical Specification

An add-on for Home Assistant that connects Voice Preview Edition satellites directly to Qwen 3.5 Omni Realtime, bypassing the Assist pipeline entirely. Audio streams end-to-end between the satellite microphone and Qwen's omni model, with function calling side-channelled back to Home Assistant for device control.

**Version:** 0.1.0-draft
**Date:** 2026-03-31

---

## 1. Architecture overview

The system has four components and three network boundaries.

```
┌─────────────────┐         TCP (LAN)         ┌──────────────────────────┐
│   Voice PE      │◄────────────────────────►  │   Bridge add-on          │
│   (ESPHome)     │   PCM audio bidir          │   (Node.js / TypeScript) │
│                 │                            │                          │
│  Wake word      │                            │  SatelliteServer         │
│  Mic + Speaker  │                            │  QwenSessionManager      │
│  XMOS frontend  │                            │  ToolExecutor            │
└─────────────────┘                            └────────┬───────┬─────────┘
                                                        │       │
                                              WSS       │       │  HTTP
                                              (internet)│       │  (Supervisor
                                                        │       │   internal)
                                                        ▼       ▼
                                               ┌────────────┐ ┌───────────┐
                                               │ Qwen 3.5   │ │ Home      │
                                               │ Omni       │ │ Assistant │
                                               │ Realtime   │ │ REST API  │
                                               │ (DashScope)│ │           │
                                               └────────────┘ └───────────┘
```

**Home Assistant's role is limited to two things:**

1. **Hosting platform** — the bridge runs as a Supervisor-managed add-on, getting automatic lifecycle management, port mapping, and access to the internal Supervisor network.
2. **Device control API** — when Qwen emits a function call (e.g. "turn on the kitchen light"), the bridge executes it against HA's REST API and feeds the result back into the Qwen session.

HA's Assist pipeline (STT, conversation agent, TTS) is not involved at any point.


## 2. Component specifications

### 2.1 Voice PE satellite (ESPHome custom component)

The Voice Preview Edition hardware is an ESP32-S3 (16MB flash, 8MB PSRAM) with an XMOS XU316 audio frontend. The XMOS chip performs hardware-level echo cancellation, beamforming, and noise suppression. Processed audio arrives at the ESP32-S3 via I2S as 16kHz, 32-bit, stereo — the ESPHome `MicrophoneSource` layer converts this to 16-bit mono, which is the format Qwen Realtime expects (PCM 16-bit signed little-endian, 16kHz, mono).

A custom ESPHome component (`qwen_voice_bridge`) replaces the stock `voice_assistant` component. It reuses the existing `micro_wake_word` component for on-device wake word detection.

#### 2.1.1 Behaviour

1. **Idle state** — `micro_wake_word` listens for the wake word. No network connection to the bridge.
2. **Wake word detected** — the component opens a TCP connection to the bridge add-on at the configured `host:port`.
3. **Handshake** — sends a `HELLO` frame containing the satellite ID (configured string, e.g. `"living-room"`).
4. **Streaming** — mic audio flows to the bridge as `AUDIO` frames. Audio from the bridge plays through the speaker. This is bidirectional and concurrent.
5. **Conversation end** — the bridge sends an `END` frame. The component closes the TCP connection, stops streaming, and returns to idle/wake word listening.
6. **Error / disconnect** — on TCP error or unexpected disconnect, the component plays a short error tone and returns to idle.

#### 2.1.2 ESPHome YAML configuration

```yaml
external_components:
  - source: github://craig-b/ha-qwen-voice-bridge
    components: [qwen_voice_bridge]

qwen_voice_bridge:
  id: qwen_bridge
  bridge_host: 192.168.1.50      # HA host IP
  bridge_port: 9100               # mapped add-on port
  satellite_id: "living-room"
  microphone:                      # MicrophoneSource sub-schema
    microphone: i2s_mics           # Voice PE microphone component ID
    bits_per_sample: 16
    gain_factor: 4
    channels:
      - 0                          # Left channel (XMOS processed output)
  speaker: announcement_resampling_speaker  # resampling speaker (accepts 16kHz/16-bit/mono)
  micro_wake_word: mww            # Voice PE micro_wake_word component ID

  # Automation triggers
  on_conversation_start:
    - light.turn_on:
        id: led_ring
        effect: "breathing"
  on_conversation_end:
    - light.turn_off:
        id: led_ring
  on_error:
    - light.turn_on:
        id: led_ring
        red: 100%
        green: 0%
        blue: 0%
    - delay: 2s
    - light.turn_off:
        id: led_ring
```

**Speaker selection note:** The Voice PE's audio output chain is:

```
announcement_resampling_speaker (16kHz/16-bit/mono accepted, resampled to 48kHz)
  → mixing_speaker (mixes announcement + media streams)
    → i2s_audio_speaker (48kHz/32-bit/stereo hardware DAC)
```

The component writes to `announcement_resampling_speaker` because it accepts the same 16kHz/16-bit/mono format that Qwen outputs. Writing directly to `i2s_audio_speaker` would require manual resampling to 48kHz/32-bit/stereo.

#### 2.1.3 File structure

The component lives in this repository under `esphome/components/qwen_voice_bridge/`:

```
esphome/components/qwen_voice_bridge/
├── __init__.py                  # ESPHome config schema + code generation
├── qwen_voice_bridge.h          # C++ header: class, state enum, members
└── qwen_voice_bridge.cpp        # C++ implementation
```

Referenced from ESPHome YAML via:

```yaml
external_components:
  - source: github://craig-b/ha-qwen-voice-bridge
    components: [qwen_voice_bridge]
    refresh: 1d
```

ESPHome resolves this to the `esphome/components/qwen_voice_bridge/` directory within the repository.

#### 2.1.4 Implementation details

##### Component class

The component extends `esphome::Component` and holds references to the microphone, speaker, and micro_wake_word components. It implements `setup()`, `loop()`, and `dump_config()`.

##### Microphone capture

Audio is captured via `MicrophoneSource`, not the raw `Microphone` directly. `MicrophoneSource` handles the conversion from the Voice PE's native 32-bit stereo I2S to 16-bit mono with configurable gain.

The `MicrophoneSource` is created by ESPHome's `microphone.microphone_source_to_code()` helper in the Python codegen. It requires its own ID and is configured via the `microphone` sub-schema (bits_per_sample, gain_factor, channels).

```cpp
// In setup():
this->mic_source_->add_data_callback([this](const std::vector<uint8_t> &data) {
    if (this->state_ == STATE_STREAMING) {
        this->mic_ring_buffer_->write((void *) data.data(), data.size());
    }
});
```

Audio accumulates in a `RingBuffer`. In `loop()`, the buffer is drained in chunks and sent as `AUDIO` frames over TCP.

##### Speaker output

Received `AUDIO` frames from the bridge contain raw 16kHz/16-bit/mono PCM. The component writes this directly to the speaker via `speaker->play(data, len)`. The speaker's internal ring buffer handles flow control — `play()` returns the number of bytes actually consumed. Unconsumed bytes are retained and retried on the next `loop()` iteration.

```cpp
// In loop(), when audio data received from bridge:
size_t written = this->speaker_->play(this->speaker_buffer_, this->speaker_buffer_size_);
if (written > 0) {
    memmove(this->speaker_buffer_, this->speaker_buffer_ + written,
            this->speaker_buffer_size_ - written);
    this->speaker_buffer_size_ -= written;
}
```

##### Wake word integration

The component registers a callback on the `micro_wake_word` component's wake word detection trigger:

```cpp
this->micro_wake_word_->get_wake_word_detected_trigger()->add_on_trigger_callback(
    [this](const std::string &wake_word) {
        if (this->state_ == STATE_IDLE) {
            this->start_conversation_();
        }
    }
);
```

When a conversation is active, wake word detections are ignored.

##### TCP networking

The component uses ESPHome's BSD socket abstraction (`esphome/components/socket/socket.h`):

```cpp
#include "esphome/components/socket/socket.h"

// In start_conversation_():
this->socket_ = esphome::socket::socket(AF_INET, SOCK_STREAM, 0);
this->socket_->setblocking(false);

struct sockaddr_in addr;
esphome::socket::set_sockaddr(&addr, sizeof(addr), this->bridge_host_.c_str(), this->bridge_port_);
int err = this->socket_->connect((struct sockaddr *)&addr, sizeof(addr));
// err == -1 && errno == EINPROGRESS is expected for non-blocking connect

// In loop():
ssize_t bytes_read = this->socket_->read(this->recv_buffer_, sizeof(this->recv_buffer_));
// bytes_read == -1 && errno == EAGAIN means no data available (normal)

ssize_t bytes_written = this->socket_->write(this->send_buffer_, this->send_buffer_size_);
```

All socket operations are non-blocking. Connection progress, reads, and writes are polled in `loop()`. The `loop()` method must remain fast (<1ms) to avoid blocking the ESPHome main loop.

##### State machine

```cpp
enum State : uint8_t {
    STATE_IDLE,              // Waiting for wake word, no TCP connection
    STATE_CONNECTING,        // TCP connect in progress (non-blocking)
    STATE_SENDING_HELLO,     // Connected, sending HELLO frame
    STATE_STREAMING,         // Bidirectional audio streaming
    STATE_ENDING,            // Received END/ERROR, draining speaker, closing
};
```

Transitions:
- `IDLE` → `CONNECTING`: wake word detected
- `CONNECTING` → `SENDING_HELLO`: TCP connect succeeds (socket becomes writable)
- `CONNECTING` → `IDLE`: TCP connect fails or 5-second timeout
- `SENDING_HELLO` → `STREAMING`: HELLO frame fully sent
- `STREAMING` → `ENDING`: received `END` or `ERROR` frame from bridge
- `STREAMING` → `IDLE`: TCP disconnect detected (read returns 0)
- `ENDING` → `IDLE`: speaker drained or 2-second drain timeout

##### Frame encoding/decoding

Same binary protocol as the bridge side (section 3.1):

```
┌──────────┬───────────────┬─────────────────────────┐
│ Type (1) │ Length (2, BE) │ Payload (0..65535 bytes) │
└──────────┴───────────────┘─────────────────────────┘
```

The component maintains a receive buffer for incremental frame parsing. Partial frames are retained across `loop()` iterations.

##### Buffer sizes

| Buffer | Size | Purpose |
|--------|------|---------|
| Mic ring buffer | 16384 bytes (~500ms audio) | Accumulates mic PCM between loop() drains |
| Speaker buffer | 8192 bytes (~250ms audio) | Holds received PCM pending speaker consumption |
| TCP receive buffer | 4096 bytes | Raw bytes from socket before frame parsing |
| TCP send buffer | 3203 bytes | One AUDIO frame: 3-byte header + 3200-byte payload (100ms) |

##### Automation triggers

Three ESPHome `Trigger<>` instances exposed for YAML automations:

| Trigger | Fires when |
|---------|-----------|
| `on_conversation_start` | State transitions to `STREAMING` (HELLO sent, bridge accepted) |
| `on_conversation_end` | State transitions to `IDLE` after normal `END` frame |
| `on_error` | State transitions to `IDLE` after `ERROR` frame or TCP failure |

##### Dependencies

The component declares these ESPHome dependencies in `__init__.py`:

```python
DEPENDENCIES = ["network"]
AUTO_LOAD = []
CONFLICTS_WITH = ["voice_assistant"]
```

It conflicts with `voice_assistant` because both components would try to claim the microphone and speaker. Only one can be active.


### 2.2 Bridge add-on (TypeScript / Node.js)

The bridge is a Supervisor add-on running in a Docker container. It manages TCP connections from satellites, WebSocket sessions to Qwen, and HTTP calls to Home Assistant.

#### 2.2.1 Module structure

```
qwen-voice-bridge/
├── Dockerfile
├── config.yaml                # Supervisor add-on metadata
├── run.sh                     # Container entry point
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts               # Bootstrap and lifecycle
    ├── config.ts              # Options loading and validation
    ├── satellite/
    │   ├── server.ts          # TCP server, accepts satellite connections
    │   ├── connection.ts      # Per-satellite connection state machine
    │   └── protocol.ts        # Binary frame encode/decode
    ├── qwen/
    │   ├── session.ts         # Qwen Realtime WebSocket session wrapper
    │   └── types.ts           # Qwen API event type definitions
    ├── ha/
    │   ├── api.ts             # HA REST + WebSocket API client
    │   ├── entities.ts        # Discover and cache Assist-exposed entities
    │   └── tools.ts           # Generate Qwen tool schema from HA entities
    └── logger.ts              # Structured logging
```

#### 2.2.2 SatelliteServer (`satellite/server.ts`)

A TCP server listening on the configured port (default `9100`). It accepts connections from Voice PE satellites and manages their lifecycle.

**Responsibilities:**

- Accept incoming TCP connections.
- Parse the `HELLO` frame to identify the satellite.
- Create a `SatelliteConnection` instance for each connected satellite.
- Route audio frames between the satellite and its associated Qwen session.
- Handle disconnections and cleanup.

**Concurrency model:**

Each satellite connection is independent. Multiple satellites can be in active conversations simultaneously, each with its own Qwen session. The server uses Node.js streams for backpressure management on the TCP socket.

#### 2.2.3 SatelliteConnection (`satellite/connection.ts`)

Manages the lifecycle of a single satellite's conversation.

**State machine:**

```
CONNECTED → HELLO_RECEIVED → CONVERSATION_ACTIVE → ENDING → DISCONNECTED
                                     ↑        │
                                     └────────┘
                                   (multi-turn)
```

**States:**

| State | Description |
|---|---|
| `CONNECTED` | TCP connection established, waiting for HELLO frame |
| `HELLO_RECEIVED` | Satellite identified, opening Qwen session |
| `CONVERSATION_ACTIVE` | Audio streaming bidirectionally, Qwen session open |
| `ENDING` | Silence timeout reached, sending END frame, closing session |
| `DISCONNECTED` | Connection closed, resources released |

**Multi-turn handling:**

After Qwen completes a response (`response.done` event), the connection remains in `CONVERSATION_ACTIVE`. Audio continues streaming. Qwen's server-side VAD detects subsequent utterances within the same session. A silence timer starts when Qwen finishes responding. If the timer expires without Qwen detecting new speech, the connection transitions to `ENDING`.

The silence timeout is configurable (default: 15 seconds). The timer resets each time Qwen emits a `response.done` event (i.e. the timeout runs from the end of the last response, not from the last detected speech).

#### 2.2.4 QwenSessionManager (`qwen/session.ts`)

Wraps a single WebSocket connection to the Qwen 3.5 Omni Realtime API.

**Connection:**

```
wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model={model_name}
```

Headers:
```
Authorization: Bearer {DASHSCOPE_API_KEY}
OpenAI-Beta: realtime=v1
```

**Session configuration (sent as `session.update` after connection):**

```json
{
  "type": "session.update",
  "session": {
    "modalities": ["text", "audio"],
    "instructions": "{system_prompt}",
    "voice": "{configured_voice}",
    "input_audio_format": "pcm16",
    "output_audio_format": "pcm16",
    "turn_detection": {
      "type": "server_vad"
    },
    "tools": [
      // ... HA tool schema, see section 4
    ]
  }
}
```

**Inbound audio (satellite → Qwen):**

PCM audio from the satellite is base64-encoded and sent as:

```json
{
  "type": "input_audio_buffer.append",
  "audio": "{base64_pcm_data}"
}
```

Audio is forwarded in the same chunk sizes received from the satellite (~100ms / 3200 bytes). No batching or re-chunking.

**Outbound audio (Qwen → satellite):**

`response.audio.delta` events contain base64-encoded PCM audio. The bridge decodes each delta and immediately writes the raw PCM bytes to the satellite's TCP socket as `AUDIO` frames. No buffering — each delta becomes one frame, preserving Qwen's streaming latency characteristics.

**Tool call handling:**

When Qwen emits tool call events (`response.function_call_arguments.done`), the session:

1. Parses the function name and arguments.
2. Passes them to the ToolExecutor.
3. Receives the result.
4. Sends a `conversation.item.create` event with the tool result back to Qwen.
5. Sends a `response.create` event to prompt Qwen to continue (incorporating the tool result into its response).

During tool execution, Qwen may still be generating audio for the pre-tool-call portion of its response. Audio streaming is not paused.

**Session lifecycle:**

- One Qwen session per satellite conversation.
- Session is opened when the satellite connects and sends HELLO.
- Session is closed when the conversation ends (silence timeout or satellite disconnect).
- The 120-minute DashScope session limit is handled by the bridge — if a session approaches the limit, it is transparently recycled (closed and reopened with the same configuration and a fresh conversation context).

**Reconnection:**

If the Qwen WebSocket drops mid-conversation:

1. The bridge attempts to reconnect (up to 3 retries, 1 second apart).
2. If reconnection succeeds, a new session is configured and the conversation resumes (previous context is lost — the model starts fresh).
3. If reconnection fails, the bridge sends an `ERROR` frame to the satellite, which returns to idle.

#### 2.2.5 ToolExecutor (`ha/tools.ts` and `ha/api.ts`)

Executes Qwen's function calls against Home Assistant.

**HA API access:**

The Supervisor injects `SUPERVISOR_TOKEN` as an environment variable in add-on containers. The bridge uses this to authenticate with HA's REST API at `http://supervisor/core/api`. No manual token configuration required.

**Exposed tools (registered with the Qwen session):**

Two tools are registered:

**`call_service`** — execute a Home Assistant service call.

```json
{
  "type": "function",
  "function": {
    "name": "call_service",
    "description": "Control a smart home device by calling a Home Assistant service. Use this when the user wants to change something (turn on/off lights, set temperature, lock/unlock doors, etc).",
    "parameters": {
      "type": "object",
      "properties": {
        "domain": {
          "type": "string",
          "description": "The entity domain (e.g. light, switch, climate, lock, cover, media_player)"
        },
        "service": {
          "type": "string",
          "description": "The service to call (e.g. turn_on, turn_off, toggle, set_temperature, lock, unlock, open_cover, close_cover)"
        },
        "entity_id": {
          "type": "string",
          "description": "The entity_id to act on (e.g. light.kitchen, climate.living_room)"
        },
        "service_data": {
          "type": "object",
          "description": "Optional additional service data (e.g. {\"brightness\": 128} for lights, {\"temperature\": 21} for climate)"
        }
      },
      "required": ["domain", "service", "entity_id"]
    }
  }
}
```

**`get_state`** — query the current state of one or more entities.

```json
{
  "type": "function",
  "function": {
    "name": "get_state",
    "description": "Get the current state and attributes of a smart home device. Use this when the user asks about the status of something.",
    "parameters": {
      "type": "object",
      "properties": {
        "entity_id": {
          "type": "string",
          "description": "The entity_id to query (e.g. sensor.outdoor_temperature, light.bedroom)"
        }
      },
      "required": ["entity_id"]
    }
  }
}
```

**Execution:**

`call_service` → `POST http://supervisor/core/api/services/{domain}/{service}` with body `{"entity_id": "...", ...service_data}`.

`get_state` → `GET http://supervisor/core/api/states/{entity_id}`. Returns the state object including `state`, `attributes`, and `last_changed`.

Results are serialised as JSON strings and returned to the Qwen session.

**Error handling:**

If a service call fails (4xx/5xx from HA), the tool result returned to Qwen contains the error message. Qwen can then communicate the failure to the user in natural language (e.g. "Sorry, I wasn't able to turn on that light — it looks like it's unavailable").


### 2.3 Entity discovery and session instructions

At conversation start, the bridge builds a system prompt for the Qwen session that includes the current state of all Assist-exposed entities. This gives Qwen the context it needs to handle requests accurately and to refer to devices by their friendly names.

#### 2.3.1 Discovery

The bridge fetches the Assist-exposed entity list from HA's WebSocket API:

```json
{
  "type": "homeassistant/expose_entity/list"
}
```

This returns the set of entities the user has chosen to expose to Assist (configured in HA's UI under Settings → Voice assistants → Expose). The bridge then fetches full state for each entity via `GET /api/states/{entity_id}`.

Entity discovery runs:

- Once at add-on startup.
- At the start of each new conversation (to capture recent changes).
- After each `call_service` tool execution (to refresh the affected entity's state in the session context).

#### 2.3.2 System prompt construction

The Qwen session `instructions` field is assembled from:

1. **Base persona prompt** — configurable in add-on options. Default:

```
You are a helpful voice assistant for a smart home. You are speaking through
a voice device, so keep responses concise and conversational. Do not use
markdown, lists, or any formatting — your output will be spoken aloud.

When the user asks to control a device, use the call_service tool.
When the user asks about device status, use the get_state tool or refer
to the device list below.
```

2. **Device context** — generated from discovered entities:

```
Available devices:

- Kitchen light (light.kitchen): on, brightness 80%
- Living room thermostat (climate.living_room): heating, target 20°C, current 18.5°C
- Front door (lock.front_door): locked
- Bedroom blinds (cover.bedroom): open, position 100%
- Outdoor temperature (sensor.outdoor_temp): 7.2°C
...
```

Each entry includes the friendly name, entity_id, current state, and key attributes. The format is kept compact to minimise token usage.

3. **Satellite context** — the satellite ID is included so Qwen can orient responses:

```
The user is speaking from the living room.
```

This allows Qwen to make contextual inferences (e.g. "turn on the light" from the living room probably means `light.living_room`).


## 3. Satellite ↔ Bridge protocol

A lightweight binary protocol over TCP. The protocol is intentionally minimal — the ESP32-S3 has limited resources and the data is almost entirely raw audio.

### 3.1 Frame format

```
┌──────────┬───────────────┬─────────────────────────┐
│ Type (1) │ Length (2, BE) │ Payload (0..65535 bytes) │
└──────────┴───────────────┘─────────────────────────┘
```

- **Type**: 1 byte, unsigned.
- **Length**: 2 bytes, big-endian unsigned integer. Length of the payload only (not including type and length bytes).
- **Payload**: variable length, interpretation depends on type.

Total frame overhead: 3 bytes per frame.

### 3.2 Message types

| Type | Name | Direction | Payload |
|------|------|-----------|---------|
| `0x01` | `HELLO` | Satellite → Bridge | UTF-8 satellite ID string (e.g. `"living-room"`) |
| `0x02` | `AUDIO` | Bidirectional | Raw PCM: 16-bit signed LE, 16kHz, mono |
| `0x03` | `END` | Bridge → Satellite | Empty (0 bytes). Signals conversation over. |
| `0x04` | `ERROR` | Bridge → Satellite | UTF-8 error message string |

### 3.3 Connection lifecycle

```
Satellite                              Bridge
   │                                      │
   │──── TCP connect ────────────────────►│
   │                                      │
   │──── HELLO("living-room") ──────────►│
   │                                      │  ← opens Qwen session
   │                                      │
   │──── AUDIO (mic PCM) ──────────────►│──── audio ────► Qwen
   │◄─── AUDIO (response PCM) ──────────│◄─── audio ──── Qwen
   │                                      │
   │  ... (multi-turn continues) ...      │
   │                                      │
   │◄─── END ────────────────────────────│  ← silence timeout
   │                                      │
   │──── TCP close ──────────────────────►│
```

### 3.4 Audio chunking

The Voice PE sends audio in chunks of approximately 100ms (3200 bytes). The bridge does not enforce a specific chunk size — it processes whatever arrives. Qwen is tolerant of varying chunk sizes.

Audio from Qwen arrives as `response.audio.delta` events containing variable-length base64-encoded PCM. Each delta is decoded and sent to the satellite as a single `AUDIO` frame. Typical delta sizes are 2000–8000 bytes (100–400ms of audio).

### 3.5 Timing

The `HELLO` frame must arrive within 2 seconds of TCP connection. If it does not, the bridge closes the connection.

There is no keepalive mechanism during a conversation. The TCP connection is inherently keepalive. If the TCP connection drops (detected by OS-level TCP keepalive, default 60 seconds), the bridge cleans up the associated Qwen session.


## 4. Qwen Realtime API integration detail

### 4.1 Event flow — standard voice interaction

```
Bridge                                        Qwen Realtime
  │                                              │
  │──── session.update (config, tools) ────────►│
  │◄─── session.updated ────────────────────────│
  │                                              │
  │──── input_audio_buffer.append ─────────────►│  (continuous)
  │──── input_audio_buffer.append ─────────────►│
  │     ...                                      │
  │                                              │
  │◄─── input_audio_buffer.speech_started ──────│  (VAD detects speech)
  │◄─── input_audio_buffer.speech_stopped ──────│  (VAD detects silence)
  │                                              │
  │◄─── response.created ──────────────────────│
  │◄─── response.audio.delta ──────────────────│  → decode, send to satellite
  │◄─── response.audio.delta ──────────────────│  → decode, send to satellite
  │◄─── response.audio_transcript.delta ───────│  → log
  │     ...                                      │
  │◄─── response.audio.done ───────────────────│
  │◄─── response.done ────────────────────────│  → start silence timer
  │                                              │
  │──── input_audio_buffer.append ─────────────►│  (still streaming mic)
  │     ... (user speaks again within timeout)   │
```

### 4.2 Event flow — interaction with function call

```
Bridge                                        Qwen Realtime
  │                                              │
  │  (user says "turn on the kitchen light")     │
  │                                              │
  │◄─── response.audio.delta ──────────────────│  "Sure, turning on..."
  │◄─── response.function_call_arguments.delta ─│
  │◄─── response.function_call_arguments.done ──│  {"name":"call_service",...}
  │                                              │
  │  ┌─── ToolExecutor ───┐                     │
  │  │ POST /api/services/ │                     │
  │  │ light/turn_on       │                     │
  │  │ {entity_id:         │                     │
  │  │  light.kitchen}     │                     │
  │  └────────┬────────────┘                     │
  │           │ result                            │
  │           ▼                                  │
  │──── conversation.item.create ──────────────►│  (tool result)
  │──── response.create ──────────────────────►│  (prompt continuation)
  │                                              │
  │◄─── response.audio.delta ──────────────────│  "...the kitchen light is on."
  │◄─── response.done ────────────────────────│
```

### 4.3 VAD behaviour

Server-side VAD is used (configured via `turn_detection.type: "server_vad"` in session config). Qwen's VAD:

- Detects speech onset and emits `input_audio_buffer.speech_started`.
- Detects speech end and emits `input_audio_buffer.speech_stopped`.
- Handles backchannel filtering — distinguishes "uh-huh" from genuine interruptions.
- Handles barge-in — if the user speaks while Qwen is responding, Qwen can stop its current response.

The bridge does not need to implement any VAD logic. The Voice PE streams audio continuously and Qwen decides when speech has started and stopped.

### 4.4 Model variants

| Model | Optimised for | Model string |
|-------|---------------|-------------|
| Plus | Maximum quality | `qwen3.5-omni-plus-realtime` |
| Flash | Latency / cost balance | `qwen3.5-omni-flash-realtime` |
| Light | Efficiency / lowest cost | `qwen3.5-omni-light-realtime` |

The model is configurable in add-on options. Default: `qwen3.5-omni-flash-realtime`.

### 4.5 Voice selection

The Flash realtime model supports 49 voices. Voice is configured per-session. The voice ID is set in the `session.update` event and applies to all audio output for that session.

Voice is configurable in add-on options. A future enhancement could allow per-satellite voice selection.

### 4.6 Audio format

Both input and output use PCM 16-bit signed little-endian, 16kHz, mono. This is specified in the session config as `pcm16`. No audio codec negotiation is needed — the format is fixed on both sides (Voice PE hardware and Qwen API).


## 5. Home Assistant API integration detail

### 5.1 Authentication

The Supervisor injects `SUPERVISOR_TOKEN` into the add-on container as an environment variable. All HA API calls use this token:

```
Authorization: Bearer ${SUPERVISOR_TOKEN}
```

The API base URL inside the Supervisor network is:

```
http://supervisor/core/api
```

No manual configuration of HA credentials is needed.

### 5.2 Entity discovery endpoint

**REST (simple, used for state fetching):**

```
GET /api/states
```

Returns all entity states. The bridge filters to Assist-exposed entities only.

**WebSocket (used for the Assist-exposed list):**

Connect to `ws://supervisor/core/api/websocket`, authenticate, then:

```json
{"type": "auth", "access_token": "${SUPERVISOR_TOKEN}"}
```

```json
{"type": "homeassistant/expose_entity/list", "id": 1}
```

The response contains the entity IDs and their exposure settings. Cross-reference with `/api/states` for full state.

### 5.3 Service execution

```
POST /api/services/{domain}/{service}
Content-Type: application/json

{
  "entity_id": "light.kitchen",
  "brightness": 200
}
```

Returns 200 on success with updated state, or 4xx/5xx on failure.

### 5.4 Entity state query

```
GET /api/states/{entity_id}
```

Returns:

```json
{
  "entity_id": "light.kitchen",
  "state": "on",
  "attributes": {
    "friendly_name": "Kitchen light",
    "brightness": 200,
    "color_mode": "brightness",
    "supported_color_modes": ["brightness"]
  },
  "last_changed": "2026-03-31T14:22:00+00:00"
}
```


## 6. Add-on packaging

### 6.1 Supervisor add-on metadata (`config.yaml`)

```yaml
name: "Qwen Voice Bridge"
description: "End-to-end voice assistant connecting Voice PE satellites to Qwen 3.5 Omni Realtime"
version: "0.1.0"
slug: "qwen_voice_bridge"
url: "https://github.com/your-org/qwen-voice-bridge"
arch:
  - amd64
  - aarch64
ports:
  9100/tcp: 9100
ports_description:
  9100/tcp: "Satellite connection port"
options:
  dashscope_api_key: ""
  qwen_model: "qwen3.5-omni-flash-realtime"
  voice: "Ethan"
  persona_prompt: "You are a helpful voice assistant for a smart home. Keep responses concise and conversational."
  satellite_port: 9100
  conversation_timeout_seconds: 15
  log_level: "info"
schema:
  dashscope_api_key: str
  qwen_model: list(qwen3.5-omni-plus-realtime|qwen3.5-omni-flash-realtime|qwen3.5-omni-light-realtime)
  voice: str
  persona_prompt: str
  satellite_port: int
  conversation_timeout_seconds: int(5,120)
  log_level: list(debug|info|warn|error)
startup: application
boot: auto
homeassistant_api: true
```

Key points:
- `homeassistant_api: true` grants the add-on access to HA's API via the Supervisor token.
- Port `9100` is exposed to the LAN for satellite connections.
- The `aarch64` architecture supports Raspberry Pi 4/5 hosts.

### 6.2 Dockerfile

```dockerfile
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
```

### 6.3 Entry point (`run.sh`)

```bash
#!/usr/bin/with-contenv bashio

export SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}"
export DASHSCOPE_API_KEY="$(bashio::config 'dashscope_api_key')"
export QWEN_MODEL="$(bashio::config 'qwen_model')"
export VOICE="$(bashio::config 'voice')"
export PERSONA_PROMPT="$(bashio::config 'persona_prompt')"
export SATELLITE_PORT="$(bashio::config 'satellite_port')"
export CONVERSATION_TIMEOUT="$(bashio::config 'conversation_timeout_seconds')"
export LOG_LEVEL="$(bashio::config 'log_level')"

cd /app
exec node dist/index.js
```


## 7. Configuration reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dashscope_api_key` | string | (required) | DashScope API key for Qwen Realtime access |
| `qwen_model` | enum | `qwen3.5-omni-flash-realtime` | Model variant: `plus`, `flash`, or `light` |
| `voice` | string | `"Ethan"` | Qwen voice ID for speech output |
| `persona_prompt` | string | (see 6.1) | Base system prompt prepended to entity context |
| `satellite_port` | integer | `9100` | TCP port for satellite connections |
| `conversation_timeout_seconds` | integer | `15` | Seconds of post-response silence before ending conversation |
| `log_level` | enum | `info` | Logging verbosity: `debug`, `info`, `warn`, `error` |


## 8. Session lifecycle — complete flow

This traces a full interaction from wake word to conversation end.

**1. Wake word**
Voice PE's microWakeWord detects the configured wake word on-device. No network traffic. The ESP32-S3 triggers the `qwen_voice_bridge` component.

**2. TCP connect**
The ESPHome component opens a TCP connection to `{bridge_host}:{bridge_port}`. The bridge's SatelliteServer accepts it.

**3. HELLO**
The satellite sends `HELLO("living-room")`. The bridge validates the frame and creates a SatelliteConnection.

**4. Qwen session open**
The bridge opens a WebSocket to DashScope. On `session.created`, it sends `session.update` with:
- The configured voice and model.
- The system prompt (persona + device context for the satellite's room).
- The tool schema (`call_service`, `get_state`).

**5. Audio streaming begins**
The satellite starts sending `AUDIO` frames (mic PCM). The bridge base64-encodes and forwards to Qwen as `input_audio_buffer.append`. This begins immediately — the user may already be speaking.

**6. User speaks**
Qwen's VAD detects speech, processes it. The model reasons about the input, potentially calling tools.

**7. Qwen responds**
`response.audio.delta` events stream back. The bridge decodes each to raw PCM and sends to the satellite as `AUDIO` frames. The Voice PE plays them through its speaker in real-time. The XMOS echo cancellation ensures the speaker output does not feed back into the microphone.

**8. Tool call (if applicable)**
If Qwen calls `call_service` or `get_state`, the bridge executes against HA's API and returns the result to the Qwen session. Qwen incorporates the result into its ongoing or next response.

**9. Response complete**
On `response.done`, the bridge starts the silence timer (configurable, default 15s). Audio streaming from the satellite continues — the user can speak again.

**10a. Follow-up utterance**
If the user speaks within the timeout, Qwen detects it (VAD), processes it, and responds. The silence timer resets on the next `response.done`. This loop repeats for as long as the user keeps talking.

**10b. Silence timeout**
If the timeout expires with no new speech from Qwen's VAD, the bridge:
1. Closes the Qwen WebSocket session.
2. Sends an `END` frame to the satellite.
3. Cleans up the SatelliteConnection.

**11. Return to idle**
The satellite receives `END`, closes the TCP connection, and the ESPHome component returns to wake word listening mode.


## 9. Error handling

| Scenario | Bridge behaviour | Satellite behaviour |
|----------|-----------------|---------------------|
| Qwen WebSocket fails to open | Send `ERROR` frame with message | Play error tone, return to idle |
| Qwen WebSocket drops mid-conversation | Retry up to 3 times (1s apart). On failure, send `ERROR` | On `ERROR`: play error tone, return to idle |
| HA API unreachable | Return error as tool result to Qwen. Qwen communicates failure to user in speech | No action (user hears Qwen's spoken error) |
| Tool call fails (4xx/5xx) | Return error as tool result to Qwen | No action (user hears Qwen's spoken error) |
| Satellite sends invalid frame | Log warning, close connection | Connection closed; return to idle |
| Satellite disconnects unexpectedly | Close Qwen session, clean up | N/A |
| HELLO not received within 2s | Close connection | Connection closed; return to idle |
| DashScope rate limit / quota | Send `ERROR` frame | Play error tone, return to idle |


## 10. Logging and observability

The bridge logs structured JSON to stdout (captured by Supervisor).

**Log levels:**

- `debug` — every frame sent/received, every Qwen event, every HA API call.
- `info` — conversation start/end, tool calls executed, errors.
- `warn` — recoverable errors (Qwen reconnection, tool call failures).
- `error` — unrecoverable errors (failed to start, persistent Qwen disconnection).

**Key log events:**

```
satellite.connected        {satellite_id, remote_ip}
satellite.disconnected     {satellite_id, reason}
qwen.session.opened        {satellite_id, model, voice}
qwen.session.closed        {satellite_id, reason, duration_s}
qwen.speech.detected       {satellite_id}
qwen.response.started      {satellite_id}
qwen.response.completed    {satellite_id, duration_ms}
qwen.tool_call             {satellite_id, function, args}
ha.service.called           {domain, service, entity_id, success}
ha.state.fetched            {entity_id}
conversation.timeout        {satellite_id, timeout_s}
error                       {satellite_id?, code, message}
```

Conversation transcripts (Qwen's `response.audio_transcript.delta` events and input transcriptions if available) are logged at `debug` level for diagnostics but not stored persistently by default.


## 11. Security considerations

**API keys:** The DashScope API key is stored in the add-on's Supervisor-managed options, which are not exposed in HA's UI to non-admin users. The key is passed to the container as an environment variable.

**HA authentication:** The Supervisor token is automatically managed and scoped to the add-on. It has full API access, which is necessary for service calls and state queries.

**Network exposure:** The satellite TCP port (default 9100) is exposed on the LAN. There is no authentication on the satellite protocol — any device on the LAN can connect and start a conversation. This mirrors the security model of the stock Voice PE (which also has no per-satellite authentication). For environments requiring satellite authentication, a shared secret could be added to the HELLO frame in a future version.

**Audio data:** Microphone audio is streamed to DashScope's cloud servers for processing. This is inherent to using the cloud API. Users requiring full local processing would need to self-host the Qwen model (not currently practical for home hardware — see constraints in section 12).


## 12. Known constraints and future considerations

**Cloud dependency.** Qwen 3.5 Omni Realtime is only available via DashScope cloud API. The open-weight Qwen3-Omni-30B can be self-hosted but requires 79+ GB VRAM, and vLLM's realtime audio serving is not production-ready. When smaller quantised omni models become available, the bridge architecture supports swapping the WebSocket endpoint to a local server with no other changes.

**Voice PE firmware.** The custom ESPHome component requires flashing modified firmware to the Voice PE. This replaces the stock `voice_assistant` component. Users cannot use both the stock Assist pipeline and the Qwen bridge simultaneously on the same device. A future enhancement could support switching between modes via a physical button or HA automation.

**Entity limits.** Large HA installations with hundreds of exposed entities will produce long system prompts, consuming Qwen context tokens. The bridge should cap the entity list at a reasonable size (e.g. 200 entities) and prioritise entities in the satellite's area. Entities beyond the cap are still controllable via tools — they just won't be listed in the system prompt context.

**No conversation history in HA.** Because the Assist pipeline is bypassed, conversations are not recorded in HA's conversation history UI. The bridge's own logs (at debug level) provide transcript data, but there is no integration with HA's native conversation tracking.

**Single wake word mode.** The Voice PE supports multiple wake words mapped to different Assist pipelines. This integration uses only one wake word, which triggers the Qwen bridge. Coexistence with a second wake word routed to HA's standard pipeline is theoretically possible but not in scope for v0.1.

**No video input.** Qwen 3.5 Omni supports audio-video input, but the Voice PE has no camera. The architecture does not preclude future satellite types with cameras — the bridge protocol and Qwen session configuration would need extensions to handle video frames.

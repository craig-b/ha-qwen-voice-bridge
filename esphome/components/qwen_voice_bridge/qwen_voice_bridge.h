#pragma once

#include "esphome/core/component.h"
#include "esphome/core/automation.h"
#include "esphome/core/ring_buffer.h"
#include "esphome/components/microphone/microphone_source.h"
#include "esphome/components/speaker/speaker.h"
#include "esphome/components/micro_wake_word/micro_wake_word.h"
#include "esphome/components/socket/socket.h"

#include <string>
#include <memory>

namespace esphome {
namespace qwen_voice_bridge {

// Frame types matching bridge protocol (section 3.2 of spec)
static const uint8_t FRAME_HELLO = 0x01;
static const uint8_t FRAME_AUDIO = 0x02;
static const uint8_t FRAME_END = 0x03;
static const uint8_t FRAME_ERROR = 0x04;

static const size_t FRAME_HEADER_SIZE = 3;  // 1 type + 2 length (BE)

// Buffer sizes (section 2.1.4 of spec)
static const size_t MIC_RING_BUFFER_SIZE = 16384;    // ~500ms at 16kHz/16-bit/mono
static const size_t SPEAKER_BUFFER_SIZE = 8192;       // ~250ms
static const size_t TCP_RECV_BUFFER_SIZE = 4096;
static const size_t AUDIO_CHUNK_SIZE = 3200;           // 100ms at 16kHz/16-bit/mono
static const size_t SEND_FRAME_SIZE = FRAME_HEADER_SIZE + AUDIO_CHUNK_SIZE;

// Timeouts
static const uint32_t CONNECT_TIMEOUT_MS = 5000;
static const uint32_t SPEAKER_DRAIN_TIMEOUT_MS = 2000;

enum State : uint8_t {
  STATE_IDLE,
  STATE_CONNECTING,
  STATE_SENDING_HELLO,
  STATE_STREAMING,
  STATE_ENDING,
};

class QwenVoiceBridge : public Component {
 public:
  void setup() override;
  void loop() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::AFTER_WIFI; }

  void set_bridge_host(const std::string &host) { this->bridge_host_ = host; }
  void set_bridge_port(uint16_t port) { this->bridge_port_ = port; }
  void set_satellite_id(const std::string &id) { this->satellite_id_ = id; }
  void set_microphone_source(microphone::MicrophoneSource *source) { this->mic_source_ = source; }
  void set_speaker(speaker::Speaker *speaker) { this->speaker_ = speaker; }
  void set_micro_wake_word(micro_wake_word::MicroWakeWord *mww) { this->micro_wake_word_ = mww; }

  Trigger<> *get_conversation_start_trigger() { return &this->conversation_start_trigger_; }
  Trigger<> *get_conversation_end_trigger() { return &this->conversation_end_trigger_; }
  Trigger<> *get_error_trigger() { return &this->error_trigger_; }

 protected:
  void start_conversation_();
  void stop_conversation_(bool error);
  void set_state_(State state);

  // loop() sub-handlers per state
  void loop_connecting_();
  void loop_sending_hello_();
  void loop_streaming_();
  void loop_ending_();

  // Networking
  void process_recv_buffer_();

  // Speaker
  void drain_speaker_buffer_();

  // Config
  std::string bridge_host_;
  uint16_t bridge_port_{9100};
  std::string satellite_id_;

  // Component references
  microphone::MicrophoneSource *mic_source_{nullptr};
  speaker::Speaker *speaker_{nullptr};
  micro_wake_word::MicroWakeWord *micro_wake_word_{nullptr};

  // State
  State state_{STATE_IDLE};

  // Socket
  std::unique_ptr<socket::Socket> socket_{nullptr};

  // Mic capture
  std::shared_ptr<RingBuffer> mic_ring_buffer_{nullptr};

  // Speaker playback
  uint8_t speaker_buffer_[SPEAKER_BUFFER_SIZE];
  size_t speaker_buffer_size_{0};

  // TCP receive — frame reassembly
  uint8_t recv_buffer_[TCP_RECV_BUFFER_SIZE];
  size_t recv_buffer_size_{0};

  // TCP send
  uint8_t send_buffer_[SEND_FRAME_SIZE];
  size_t send_buffer_pending_{0};
  size_t send_buffer_offset_{0};

  // HELLO frame (built once in start_conversation_)
  uint8_t hello_frame_[FRAME_HEADER_SIZE + 64];  // max 64-byte satellite ID
  size_t hello_frame_size_{0};
  size_t hello_frame_sent_{0};

  // Triggers
  Trigger<> conversation_start_trigger_;
  Trigger<> conversation_end_trigger_;
  Trigger<> error_trigger_;
};

}  // namespace qwen_voice_bridge
}  // namespace esphome

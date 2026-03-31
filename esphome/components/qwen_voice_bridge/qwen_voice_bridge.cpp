#include "qwen_voice_bridge.h"
#include "esphome/core/log.h"

#include <cstring>
#include <cerrno>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

namespace esphome {
namespace qwen_voice_bridge {

static const char *const TAG = "qwen_voice_bridge";

void QwenVoiceBridge::setup() {
  ESP_LOGCONFIG(TAG, "Setting up Qwen Voice Bridge...");

  // Allocate mic ring buffer
  this->mic_ring_buffer_ = RingBuffer::create(MIC_RING_BUFFER_SIZE);
  if (this->mic_ring_buffer_ == nullptr) {
    ESP_LOGE(TAG, "Failed to allocate mic ring buffer");
    this->mark_failed();
    return;
  }

  // Register microphone data callback — writes to ring buffer when streaming
  this->mic_source_->add_data_callback([this](const std::vector<uint8_t> &data) {
    if (this->state_ == STATE_STREAMING) {
      this->mic_ring_buffer_->write((void *) data.data(), data.size());
    }
  });

  // Register wake word callback
  this->micro_wake_word_->get_wake_word_detected_trigger()->add_on_trigger_callback(
      [this](const std::string &wake_word) {
        if (this->state_ == STATE_IDLE) {
          ESP_LOGI(TAG, "Wake word detected: %s", wake_word.c_str());
          this->start_conversation_();
        }
      });

  ESP_LOGI(TAG, "Setup complete, waiting for wake word");
}

void QwenVoiceBridge::dump_config() {
  ESP_LOGCONFIG(TAG, "Qwen Voice Bridge:");
  ESP_LOGCONFIG(TAG, "  Bridge Host: %s", this->bridge_host_.c_str());
  ESP_LOGCONFIG(TAG, "  Bridge Port: %u", this->bridge_port_);
  ESP_LOGCONFIG(TAG, "  Satellite ID: %s", this->satellite_id_.c_str());
}

void QwenVoiceBridge::loop() {
  switch (this->state_) {
    case STATE_IDLE:
      break;
    case STATE_CONNECTING:
      this->loop_connecting_();
      break;
    case STATE_SENDING_HELLO:
      this->loop_sending_hello_();
      break;
    case STATE_STREAMING:
      this->loop_streaming_();
      break;
    case STATE_ENDING:
      this->loop_ending_();
      break;
  }
}

// --- State management ---

void QwenVoiceBridge::set_state_(State state) {
  if (this->state_ == state)
    return;
  ESP_LOGD(TAG, "State: %u -> %u", this->state_, state);
  this->state_ = state;
}

// --- Conversation lifecycle ---

void QwenVoiceBridge::start_conversation_() {
  ESP_LOGI(TAG, "Starting conversation, connecting to %s:%u", this->bridge_host_.c_str(), this->bridge_port_);

  // Create non-blocking TCP socket
  this->socket_ = socket::socket(AF_INET, SOCK_STREAM, 0);
  if (this->socket_ == nullptr) {
    ESP_LOGE(TAG, "Failed to create socket");
    this->error_trigger_.trigger();
    return;
  }
  this->socket_->setblocking(false);

  // Initiate non-blocking connect
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons(this->bridge_port_);
  inet_pton(AF_INET, this->bridge_host_.c_str(), &addr.sin_addr);

  int err = this->socket_->connect((struct sockaddr *) &addr, sizeof(addr));
  if (err != 0 && errno != EINPROGRESS) {
    ESP_LOGE(TAG, "Connect failed immediately: errno %d", errno);
    this->socket_ = nullptr;
    this->error_trigger_.trigger();
    return;
  }

  // Prepare HELLO frame
  size_t id_len = std::min(this->satellite_id_.size(), (size_t) 64);
  this->hello_frame_[0] = FRAME_HELLO;
  this->hello_frame_[1] = (uint8_t) (id_len >> 8);
  this->hello_frame_[2] = (uint8_t) (id_len & 0xFF);
  memcpy(this->hello_frame_ + FRAME_HEADER_SIZE, this->satellite_id_.c_str(), id_len);
  this->hello_frame_size_ = FRAME_HEADER_SIZE + id_len;
  this->hello_frame_sent_ = 0;

  // Reset buffers
  this->recv_buffer_size_ = 0;
  this->speaker_buffer_size_ = 0;
  this->send_buffer_pending_ = 0;
  this->send_buffer_offset_ = 0;
  this->mic_ring_buffer_->reset();

  // Start connect timeout
  this->set_timeout("connect_timeout", CONNECT_TIMEOUT_MS, [this]() {
    if (this->state_ == STATE_CONNECTING) {
      ESP_LOGW(TAG, "Connect timeout");
      this->stop_conversation_(true);
    }
  });

  this->set_state_(STATE_CONNECTING);
}

void QwenVoiceBridge::stop_conversation_(bool error) {
  ESP_LOGI(TAG, "Stopping conversation (error=%s)", error ? "true" : "false");

  this->cancel_timeout("connect_timeout");
  this->cancel_timeout("drain_timeout");

  // Close socket
  if (this->socket_ != nullptr) {
    this->socket_->close();
    this->socket_ = nullptr;
  }

  // Stop microphone
  this->mic_source_->stop();

  // Stop speaker if no data to drain
  if (this->speaker_buffer_size_ == 0) {
    this->speaker_->stop();
  }

  this->set_state_(STATE_IDLE);

  if (error) {
    this->error_trigger_.trigger();
  } else {
    this->conversation_end_trigger_.trigger();
  }
}

// --- State loop handlers ---

void QwenVoiceBridge::loop_connecting_() {
  // Check if connect completed by attempting a zero-length write
  // For non-blocking connect, the socket becomes writable on success
  int err = 0;
  socklen_t len = sizeof(err);
  if (this->socket_->getsockopt(SOL_SOCKET, SO_ERROR, &err, &len) < 0 || err != 0) {
    // Not connected yet or error — EINPROGRESS means still trying
    if (err != 0 && err != EINPROGRESS) {
      ESP_LOGE(TAG, "Connect failed: errno %d", err);
      this->stop_conversation_(true);
    }
    return;
  }

  // Connected — move to sending HELLO
  ESP_LOGI(TAG, "Connected to bridge");
  this->cancel_timeout("connect_timeout");
  this->set_state_(STATE_SENDING_HELLO);
}

void QwenVoiceBridge::loop_sending_hello_() {
  // Send remaining HELLO frame bytes
  size_t remaining = this->hello_frame_size_ - this->hello_frame_sent_;
  if (remaining == 0) {
    // HELLO fully sent — start streaming
    ESP_LOGI(TAG, "HELLO sent, starting audio stream");
    this->mic_source_->start();
    this->speaker_->start();
    this->set_state_(STATE_STREAMING);
    this->conversation_start_trigger_.trigger();
    return;
  }

  ssize_t written = this->socket_->write(
      this->hello_frame_ + this->hello_frame_sent_, remaining);

  if (written > 0) {
    this->hello_frame_sent_ += written;
  } else if (written < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
    ESP_LOGE(TAG, "Failed to send HELLO: errno %d", errno);
    this->stop_conversation_(true);
  }
}

void QwenVoiceBridge::loop_streaming_() {
  // 1. Read from TCP socket
  ssize_t bytes_read = this->socket_->read(
      this->recv_buffer_ + this->recv_buffer_size_,
      TCP_RECV_BUFFER_SIZE - this->recv_buffer_size_);

  if (bytes_read > 0) {
    this->recv_buffer_size_ += bytes_read;
    this->process_recv_buffer_();
  } else if (bytes_read == 0) {
    // Connection closed by bridge
    ESP_LOGI(TAG, "Bridge closed connection");
    this->stop_conversation_(false);
    return;
  } else if (errno != EAGAIN && errno != EWOULDBLOCK) {
    ESP_LOGE(TAG, "Socket read error: errno %d", errno);
    this->stop_conversation_(true);
    return;
  }

  // 2. Drain speaker buffer
  this->drain_speaker_buffer_();

  // 3. Send mic audio — drain ring buffer into AUDIO frames
  // Only send if no partial send is pending
  if (this->send_buffer_pending_ == 0) {
    uint8_t mic_chunk[AUDIO_CHUNK_SIZE];
    size_t available = this->mic_ring_buffer_->available();
    if (available >= AUDIO_CHUNK_SIZE) {
      this->mic_ring_buffer_->read((void *) mic_chunk, AUDIO_CHUNK_SIZE, 0);

      // Build AUDIO frame in send buffer
      this->send_buffer_[0] = FRAME_AUDIO;
      this->send_buffer_[1] = (uint8_t) (AUDIO_CHUNK_SIZE >> 8);
      this->send_buffer_[2] = (uint8_t) (AUDIO_CHUNK_SIZE & 0xFF);
      memcpy(this->send_buffer_ + FRAME_HEADER_SIZE, mic_chunk, AUDIO_CHUNK_SIZE);
      this->send_buffer_pending_ = FRAME_HEADER_SIZE + AUDIO_CHUNK_SIZE;
      this->send_buffer_offset_ = 0;
    }
  }

  // Flush pending send buffer
  if (this->send_buffer_pending_ > 0) {
    ssize_t written = this->socket_->write(
        this->send_buffer_ + this->send_buffer_offset_,
        this->send_buffer_pending_);

    if (written > 0) {
      this->send_buffer_offset_ += written;
      this->send_buffer_pending_ -= written;
    } else if (written < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
      ESP_LOGE(TAG, "Socket write error: errno %d", errno);
      this->stop_conversation_(true);
      return;
    }
  }
}

void QwenVoiceBridge::loop_ending_() {
  // Drain remaining speaker data, then go idle
  this->drain_speaker_buffer_();

  if (this->speaker_buffer_size_ == 0 && !this->speaker_->has_buffered_data()) {
    this->speaker_->stop();
    this->cancel_timeout("drain_timeout");
    this->set_state_(STATE_IDLE);
    this->conversation_end_trigger_.trigger();
  }
}

// --- Frame processing ---

void QwenVoiceBridge::process_recv_buffer_() {
  while (this->recv_buffer_size_ >= FRAME_HEADER_SIZE) {
    uint8_t type = this->recv_buffer_[0];
    uint16_t payload_len = (this->recv_buffer_[1] << 8) | this->recv_buffer_[2];
    size_t total_len = FRAME_HEADER_SIZE + payload_len;

    if (this->recv_buffer_size_ < total_len) {
      break;  // Incomplete frame, wait for more data
    }

    uint8_t *payload = this->recv_buffer_ + FRAME_HEADER_SIZE;

    switch (type) {
      case FRAME_AUDIO: {
        // Append to speaker buffer if space available
        size_t space = SPEAKER_BUFFER_SIZE - this->speaker_buffer_size_;
        size_t to_copy = std::min((size_t) payload_len, space);
        if (to_copy > 0) {
          memcpy(this->speaker_buffer_ + this->speaker_buffer_size_, payload, to_copy);
          this->speaker_buffer_size_ += to_copy;
        }
        if (to_copy < payload_len) {
          ESP_LOGW(TAG, "Speaker buffer full, dropped %u bytes", payload_len - to_copy);
        }
        break;
      }
      case FRAME_END: {
        ESP_LOGI(TAG, "Received END frame");
        // Close socket, drain speaker, then go idle
        this->socket_->close();
        this->socket_ = nullptr;
        this->mic_source_->stop();
        this->set_state_(STATE_ENDING);
        // Set a drain timeout so we don't hang forever
        this->set_timeout("drain_timeout", SPEAKER_DRAIN_TIMEOUT_MS, [this]() {
          if (this->state_ == STATE_ENDING) {
            ESP_LOGW(TAG, "Speaker drain timeout");
            this->speaker_->stop();
            this->set_state_(STATE_IDLE);
            this->conversation_end_trigger_.trigger();
          }
        });
        // Consume this frame and stop processing more
        memmove(this->recv_buffer_, this->recv_buffer_ + total_len,
                this->recv_buffer_size_ - total_len);
        this->recv_buffer_size_ -= total_len;
        return;
      }
      case FRAME_ERROR: {
        std::string msg((char *) payload, payload_len);
        ESP_LOGE(TAG, "Received ERROR frame: %s", msg.c_str());
        this->stop_conversation_(true);
        return;
      }
      default:
        ESP_LOGW(TAG, "Unknown frame type: 0x%02X", type);
        break;
    }

    // Consume the processed frame
    memmove(this->recv_buffer_, this->recv_buffer_ + total_len,
            this->recv_buffer_size_ - total_len);
    this->recv_buffer_size_ -= total_len;
  }
}

// --- Speaker ---

void QwenVoiceBridge::drain_speaker_buffer_() {
  if (this->speaker_buffer_size_ == 0)
    return;

  size_t write_chunk = std::min(this->speaker_buffer_size_, (size_t) 4096);
  size_t written = this->speaker_->play(this->speaker_buffer_, write_chunk);
  if (written > 0) {
    memmove(this->speaker_buffer_, this->speaker_buffer_ + written,
            this->speaker_buffer_size_ - written);
    this->speaker_buffer_size_ -= written;
  }
}

}  // namespace qwen_voice_bridge
}  // namespace esphome

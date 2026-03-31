export interface QwenSessionConfig {
  modalities: string[];
  instructions: string;
  voice: string;
  input_audio_format: string;
  output_audio_format: string;
  turn_detection: { type: string };
  tools: QwenToolDefinition[];
}

export interface QwenToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, QwenToolParameter>;
      required: string[];
    };
  };
}

export interface QwenToolParameter {
  type: string;
  description: string;
}

// Events sent to Qwen
export interface SessionUpdateEvent {
  type: "session.update";
  session: QwenSessionConfig;
}

export interface InputAudioBufferAppendEvent {
  type: "input_audio_buffer.append";
  audio: string; // base64
}

export interface ConversationItemCreateEvent {
  type: "conversation.item.create";
  item: {
    type: "function_call_output";
    call_id: string;
    output: string;
  };
}

export interface ResponseCreateEvent {
  type: "response.create";
}

export type QwenClientEvent =
  | SessionUpdateEvent
  | InputAudioBufferAppendEvent
  | ConversationItemCreateEvent
  | ResponseCreateEvent;

// Events received from Qwen
export interface SessionCreatedEvent {
  type: "session.created";
}

export interface SessionUpdatedEvent {
  type: "session.updated";
}

export interface ResponseAudioDeltaEvent {
  type: "response.audio.delta";
  delta: string; // base64
}

export interface ResponseAudioDoneEvent {
  type: "response.audio.done";
}

export interface ResponseAudioTranscriptDeltaEvent {
  type: "response.audio_transcript.delta";
  delta: string;
}

export interface ResponseDoneEvent {
  type: "response.done";
  response: {
    output?: Array<{
      type: string;
      name?: string;
      call_id?: string;
      arguments?: string;
    }>;
  };
}

export interface FunctionCallArgumentsDoneEvent {
  type: "response.function_call_arguments.done";
  call_id: string;
  name: string;
  arguments: string;
}

export interface InputAudioBufferSpeechStartedEvent {
  type: "input_audio_buffer.speech_started";
}

export interface InputAudioBufferSpeechStoppedEvent {
  type: "input_audio_buffer.speech_stopped";
}

export interface ErrorEvent {
  type: "error";
  error: {
    type: string;
    code: string;
    message: string;
  };
}

export type QwenServerEvent =
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | ResponseAudioDeltaEvent
  | ResponseAudioDoneEvent
  | ResponseAudioTranscriptDeltaEvent
  | ResponseDoneEvent
  | FunctionCallArgumentsDoneEvent
  | InputAudioBufferSpeechStartedEvent
  | InputAudioBufferSpeechStoppedEvent
  | ErrorEvent;

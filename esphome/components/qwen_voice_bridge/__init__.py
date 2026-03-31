import esphome.codegen as cg
import esphome.config_validation as cv
from esphome import automation
from esphome.components import microphone, speaker
from esphome.const import (
    CONF_ID,
    CONF_MICROPHONE,
    CONF_SPEAKER,
)

CODEOWNERS = ["@craig-b"]
DEPENDENCIES = ["network", "microphone", "speaker"]
CONFLICTS_WITH = ["voice_assistant"]

CONF_BRIDGE_HOST = "bridge_host"
CONF_BRIDGE_PORT = "bridge_port"
CONF_SATELLITE_ID = "satellite_id"
CONF_ON_CONVERSATION_START = "on_conversation_start"
CONF_ON_CONVERSATION_END = "on_conversation_end"
CONF_ON_ERROR = "on_error"

qwen_voice_bridge_ns = cg.esphome_ns.namespace("qwen_voice_bridge")
QwenVoiceBridge = qwen_voice_bridge_ns.class_("QwenVoiceBridge", cg.Component)
StartConversationAction = QwenVoiceBridge.class_(
    "StartConversationAction", automation.Action
)

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(QwenVoiceBridge),
        cv.Required(CONF_BRIDGE_HOST): cv.string,
        cv.Optional(CONF_BRIDGE_PORT, default=9100): cv.port,
        cv.Required(CONF_SATELLITE_ID): cv.string,
        cv.Required(CONF_MICROPHONE): microphone.microphone_source_schema(),
        cv.Required(CONF_SPEAKER): cv.use_id(speaker.Speaker),
        cv.Optional(CONF_ON_CONVERSATION_START): automation.validate_automation(
            single=True
        ),
        cv.Optional(CONF_ON_CONVERSATION_END): automation.validate_automation(
            single=True
        ),
        cv.Optional(CONF_ON_ERROR): automation.validate_automation(single=True),
    }
).extend(cv.COMPONENT_SCHEMA)

# Action: qwen_voice_bridge.start_conversation
QWEN_VOICE_BRIDGE_START_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.use_id(QwenVoiceBridge),
    }
)


@automation.register_action(
    "qwen_voice_bridge.start_conversation",
    StartConversationAction,
    QWEN_VOICE_BRIDGE_START_SCHEMA,
)
async def start_conversation_action_to_code(config, action_id, template_arg, args):
    var = cg.new_Pvariable(action_id, template_arg, await cg.get_variable(config[CONF_ID]))
    return var


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)

    cg.add(var.set_bridge_host(config[CONF_BRIDGE_HOST]))
    cg.add(var.set_bridge_port(config[CONF_BRIDGE_PORT]))
    cg.add(var.set_satellite_id(config[CONF_SATELLITE_ID]))

    mic_source = await microphone.microphone_source_to_code(config[CONF_MICROPHONE])
    cg.add(var.set_microphone_source(mic_source))

    spk = await cg.get_variable(config[CONF_SPEAKER])
    cg.add(var.set_speaker(spk))

    if CONF_ON_CONVERSATION_START in config:
        await automation.build_automation(
            var.get_conversation_start_trigger(),
            [],
            config[CONF_ON_CONVERSATION_START],
        )

    if CONF_ON_CONVERSATION_END in config:
        await automation.build_automation(
            var.get_conversation_end_trigger(),
            [],
            config[CONF_ON_CONVERSATION_END],
        )

    if CONF_ON_ERROR in config:
        await automation.build_automation(
            var.get_error_trigger(),
            [],
            config[CONF_ON_ERROR],
        )

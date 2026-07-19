const CapabilityMqttHandle = require("../../../backend/lib/mqtt/capabilities/CapabilityMqttHandle");
const Commands = require("../../../backend/lib/mqtt/common/Commands");
const ComponentType = require("../../../backend/lib/mqtt/homeassistant/ComponentType");
const DataType = require("../../../backend/lib/mqtt/homie/DataType");
const EntityCategory = require("../../../backend/lib/mqtt/homeassistant/EntityCategory");
const InLineHassComponent = require("../../../backend/lib/mqtt/homeassistant/components/InLineHassComponent");
const PropertyMqttHandle = require("../../../backend/lib/mqtt/handles/PropertyMqttHandle");

class TextToSpeechCapabilityMqttHandle extends CapabilityMqttHandle {
    /**
     * @param {object} options
     * @param {import("../../../backend/lib/mqtt/handles/RobotMqttHandle")} options.parent
     * @param {import("../../../backend/lib/mqtt/MqttController")} options.controller
     * @param {import("../../../backend/lib/core/ValetudoRobot")} options.robot
     * @param {import("../core-capabilities/TextToSpeechCapability")} options.capability
     */
    constructor(options) {
        super(Object.assign(options, {
            friendlyName: "Text to Speech"
        }));
        /** @type {import("../core-capabilities/TextToSpeechCapability")} */
        this.capability = options.capability;

        this.registerChild(new PropertyMqttHandle({
            parent: this,
            controller: this.controller,
            topicName: "speak",
            friendlyName: "Speak",
            datatype: DataType.STRING,
            setter: async (value) => {
                await this.capability.speak(value);
            },
            helpText: "Speaks the supplied text through the robot speaker."
        }).also((prop) => {
            this.controller.withHass((hass) => {
                prop.attachHomeAssistantComponent(new InLineHassComponent({
                    hass: hass,
                    robot: this.robot,
                    name: "text_to_speech",
                    friendlyName: "Speak",
                    componentType: ComponentType.NOTIFY,
                    autoconf: {
                        command_topic: `${prop.getBaseTopic()}/set`,
                        icon: "mdi:account-voice"
                    }
                }));
            });
        }));

        this.registerChild(new PropertyMqttHandle({
            parent: this,
            controller: this.controller,
            topicName: "speaking",
            friendlyName: "Speaking",
            datatype: DataType.BOOLEAN,
            getter: async () => {
                const status = await this.capability.getStatus();
                return status.speaking;
            },
            helpText: "Reports whether the robot is currently playing speech or audio."
        }).also((prop) => {
            this.controller.withHass((hass) => {
                prop.attachHomeAssistantComponent(new InLineHassComponent({
                    hass: hass,
                    robot: this.robot,
                    name: "text_to_speech_speaking",
                    friendlyName: "Speaking",
                    componentType: ComponentType.BINARY_SENSOR,
                    autoconf: {
                        state_topic: prop.getBaseTopic(),
                        payload_off: "false",
                        payload_on: "true",
                        icon: "mdi:account-voice",
                        entity_category: EntityCategory.DIAGNOSTIC
                    }
                }));
            });
        }));

        this.registerChild(new PropertyMqttHandle({
            parent: this,
            controller: this.controller,
            topicName: "stop",
            friendlyName: "Stop audio",
            datatype: DataType.ENUM,
            format: Commands.BASIC.PERFORM,
            setter: async () => {
                await this.capability.stopAudio();
            },
            helpText: "Stops speech or audio currently playing through the robot speaker."
        }).also((prop) => {
            this.controller.withHass((hass) => {
                prop.attachHomeAssistantComponent(new InLineHassComponent({
                    hass: hass,
                    robot: this.robot,
                    name: "text_to_speech_stop",
                    friendlyName: "Stop Audio",
                    componentType: ComponentType.BUTTON,
                    autoconf: {
                        command_topic: `${prop.getBaseTopic()}/set`,
                        payload_press: Commands.BASIC.PERFORM,
                        icon: "mdi:stop",
                        entity_category: EntityCategory.CONFIG
                    }
                }));
            });
        }));
    }
}

TextToSpeechCapabilityMqttHandle.OPTIONAL = false;

module.exports = TextToSpeechCapabilityMqttHandle;

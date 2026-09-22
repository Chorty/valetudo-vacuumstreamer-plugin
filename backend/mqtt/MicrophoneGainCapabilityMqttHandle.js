const CapabilityMqttHandle = require("../../../backend/lib/mqtt/capabilities/CapabilityMqttHandle");
const ComponentType = require("../../../backend/lib/mqtt/homeassistant/ComponentType");
const DataType = require("../../../backend/lib/mqtt/homie/DataType");
const EntityCategory = require("../../../backend/lib/mqtt/homeassistant/EntityCategory");
const InLineHassComponent = require("../../../backend/lib/mqtt/homeassistant/components/InLineHassComponent");
const PropertyMqttHandle = require("../../../backend/lib/mqtt/handles/PropertyMqttHandle");

class MicrophoneGainCapabilityMqttHandle extends CapabilityMqttHandle {
    /**
     * @param {object} options
     * @param {import("../../../backend/lib/mqtt/handles/RobotMqttHandle")} options.parent
     * @param {import("../../../backend/lib/mqtt/MqttController")} options.controller
     * @param {import("../../../backend/lib/core/ValetudoRobot")} options.robot
     * @param {import("../core-capabilities/MicrophoneGainCapability")} options.capability
     */
    constructor(options) {
        super(Object.assign(options, {
            friendlyName: "Microphone Gain"
        }));
        this.capability = options.capability;

        this.registerChild(
            new PropertyMqttHandle({
                parent: this,
                controller: this.controller,
                topicName: "value",
                friendlyName: "Microphone Gain",
                datatype: DataType.INTEGER,
                format: `${this.capability.getProperties().min}:${this.capability.getProperties().max}`,
                setter: async (value) => {
                    if (Number.isInteger(value) && value >= this.capability.getProperties().min && value <= this.capability.getProperties().max) {
                        await this.capability.setGain(value);
                    } else {
                        throw new Error("Invalid microphone gain");
                    }
                },
                getter: async () => {
                    return this.capability.getGain();
                },
                helpText: "This handle returns the current microphone gain"
            }).also((prop) => {
                this.controller.withHass((hass) => {
                    prop.attachHomeAssistantComponent(
                        new InLineHassComponent({
                            hass: hass,
                            robot: this.robot,
                            name: this.capability.getType(),
                            friendlyName: "Microphone Gain",
                            componentType: ComponentType.NUMBER,
                            autoconf: {
                                state_topic: prop.getBaseTopic(),
                                command_topic: prop.getBaseTopic() + "/set",
                                icon: "mdi:microphone",
                                entity_category: EntityCategory.CONFIG,
                            }
                        })
                    );
                });
            })
        );
    }
}

MicrophoneGainCapabilityMqttHandle.OPTIONAL = true;

module.exports = MicrophoneGainCapabilityMqttHandle;

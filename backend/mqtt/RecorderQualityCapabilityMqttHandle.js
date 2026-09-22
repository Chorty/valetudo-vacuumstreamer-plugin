const CapabilityMqttHandle = require("../../../backend/lib/mqtt/capabilities/CapabilityMqttHandle");
const ComponentType = require("../../../backend/lib/mqtt/homeassistant/ComponentType");
const DataType = require("../../../backend/lib/mqtt/homie/DataType");
const EntityCategory = require("../../../backend/lib/mqtt/homeassistant/EntityCategory");
const InLineHassComponent = require("../../../backend/lib/mqtt/homeassistant/components/InLineHassComponent");
const PropertyMqttHandle = require("../../../backend/lib/mqtt/handles/PropertyMqttHandle");

class RecorderQualityCapabilityMqttHandle extends CapabilityMqttHandle {
    /**
     * @param {object} options
     * @param {import("../../../backend/lib/mqtt/handles/RobotMqttHandle")} options.parent
     * @param {import("../../../backend/lib/mqtt/MqttController")} options.controller
     * @param {import("../../../backend/lib/core/ValetudoRobot")} options.robot
     * @param {import("../core-capabilities/RecorderQualityCapability")} options.capability
     */
    constructor(options) {
        super(Object.assign(options, {
            friendlyName: "Recorder Quality"
        }));
        this.capability = options.capability;

        this.registerChild(
            new PropertyMqttHandle({
                parent: this,
                controller: this.controller,
                topicName: "profile",
                friendlyName: "Recorder Quality",
                datatype: DataType.ENUM,
                format: this.capability.getProperties().supportedProfiles.join(","),
                setter: async (value) => {
                    await this.capability.setQuality(value);
                },
                getter: async () => {
                    const status = await this.capability.getQuality();

                    return status.profile;
                },
                helpText: "This handle allows setting the recorder (video encoder) quality profile. " +
                    "It accepts the payloads specified in `$format`."
            }).also((prop) => {
                this.controller.withHass((hass) => {
                    prop.attachHomeAssistantComponent(
                        new InLineHassComponent({
                            hass: hass,
                            robot: this.robot,
                            name: this.capability.getType(),
                            friendlyName: "Recorder Quality",
                            componentType: ComponentType.SELECT,
                            autoconf: {
                                state_topic: prop.getBaseTopic(),
                                value_template: "{{ value }}",
                                command_topic: prop.getBaseTopic() + "/set",
                                options: this.capability.getProperties().supportedProfiles,
                                icon: "mdi:video",
                                entity_category: EntityCategory.CONFIG,
                            }
                        })
                    );
                });
            })
        );
    }
}

RecorderQualityCapabilityMqttHandle.OPTIONAL = true;

module.exports = RecorderQualityCapabilityMqttHandle;

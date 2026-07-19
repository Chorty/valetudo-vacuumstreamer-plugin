const CapabilityMqttHandle = require("../../../backend/lib/mqtt/capabilities/CapabilityMqttHandle");
const Commands = require("../../../backend/lib/mqtt/common/Commands");
const ComponentType = require("../../../backend/lib/mqtt/homeassistant/ComponentType");
const DataType = require("../../../backend/lib/mqtt/homie/DataType");
const EntityCategory = require("../../../backend/lib/mqtt/homeassistant/EntityCategory");
const InLineHassComponent = require("../../../backend/lib/mqtt/homeassistant/components/InLineHassComponent");
const PropertyMqttHandle = require("../../../backend/lib/mqtt/handles/PropertyMqttHandle");

class VideoStreamCapabilityMqttHandle extends CapabilityMqttHandle {
    /**
     * @param {object} options
     * @param {import("../../../backend/lib/mqtt/handles/RobotMqttHandle")} options.parent
     * @param {import("../../../backend/lib/mqtt/MqttController")} options.controller
     * @param {import("../../../backend/lib/core/ValetudoRobot")} options.robot
     * @param {import("../core-capabilities/VideoStreamCapability")} options.capability
     */
    constructor(options) {
        super(Object.assign(options, {
            friendlyName: "Video Stream"
        }));
        /** @type {import("../core-capabilities/VideoStreamCapability")} */
        this.capability = options.capability;

        this.registerChild(new PropertyMqttHandle({
            parent: this,
            controller: this.controller,
            topicName: "enabled",
            friendlyName: "Video Stream",
            datatype: DataType.ENUM,
            format: Object.values(Commands.SWITCH).join(","),
            setter: async (value) => {
                if (value === Commands.SWITCH.ON) {
                    await this.capability.startStream();
                } else if (value === Commands.SWITCH.OFF) {
                    await this.capability.stopStream();
                } else {
                    throw new Error("Invalid value");
                }
            },
            getter: async () => {
                const status = await this.capability.getStreamStatus();
                return status.active ? Commands.SWITCH.ON : Commands.SWITCH.OFF;
            },
            helpText: "Starts or stops the robot video streaming pipeline."
        }).also((prop) => {
            this.controller.withHass((hass) => {
                prop.attachHomeAssistantComponent(new InLineHassComponent({
                    hass: hass,
                    robot: this.robot,
                    name: "video_stream",
                    friendlyName: "Video Stream",
                    componentType: ComponentType.SWITCH,
                    autoconf: {
                        state_topic: prop.getBaseTopic(),
                        command_topic: `${prop.getBaseTopic()}/set`,
                        icon: "mdi:video",
                        entity_category: EntityCategory.CONFIG
                    }
                }));
            });
        }));

        for (const [type, friendlyName] of Object.entries(STREAM_URL_NAMES)) {
            this.registerChild(new PropertyMqttHandle({
                parent: this,
                controller: this.controller,
                topicName: `${type}_url`,
                friendlyName: friendlyName,
                datatype: DataType.STRING,
                getter: async () => {
                    const urls = await this.capability.getStreamURLs();
                    return urls[type] ?? "";
                },
                helpText: `Reports the ${friendlyName}.`
            }).also((prop) => {
                this.controller.withHass((hass) => {
                    prop.attachHomeAssistantComponent(new InLineHassComponent({
                        hass: hass,
                        robot: this.robot,
                        name: `${type}_stream_url`,
                        friendlyName: friendlyName,
                        componentType: ComponentType.SENSOR,
                        autoconf: {
                            state_topic: prop.getBaseTopic(),
                            icon: "mdi:link",
                            enabled_by_default: false,
                            entity_category: EntityCategory.DIAGNOSTIC
                        }
                    }));
                });
            }));
        }
    }
}

const STREAM_URL_NAMES = Object.freeze({
    rtsp: "RTSP Stream URL",
    webrtc: "WebRTC Stream URL"
});

VideoStreamCapabilityMqttHandle.OPTIONAL = false;

module.exports = VideoStreamCapabilityMqttHandle;

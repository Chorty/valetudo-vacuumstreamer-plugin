const CapabilityMqttHandle = require("../../../backend/lib/mqtt/capabilities/CapabilityMqttHandle");
const Commands = require("../../../backend/lib/mqtt/common/Commands");
const ComponentType = require("../../../backend/lib/mqtt/homeassistant/ComponentType");
const DataType = require("../../../backend/lib/mqtt/homie/DataType");
const EntityCategory = require("../../../backend/lib/mqtt/homeassistant/EntityCategory");
const InLineHassComponent = require("../../../backend/lib/mqtt/homeassistant/components/InLineHassComponent");
const PropertyMqttHandle = require("../../../backend/lib/mqtt/handles/PropertyMqttHandle");

class MopDockDryManualTriggerCapabilityMqttHandle extends CapabilityMqttHandle {
    /**
     * @param {object} options
     * @param {import("../../../backend/lib/mqtt/handles/RobotMqttHandle")} options.parent
     * @param {import("../../../backend/lib/mqtt/MqttController")} options.controller
     * @param {import("../../../backend/lib/core/ValetudoRobot")} options.robot
     * @param {import("../../../backend/lib/core/capabilities/MopDockDryManualTriggerCapability")} options.capability
     */
    constructor(options) {
        super(Object.assign(options, {
            friendlyName: "Mop Dock Drying"
        }));
        /** @type {import("../../../backend/lib/core/capabilities/MopDockDryManualTriggerCapability")} */
        this.capability = options.capability;

        this.registerAction({
            topicName: "start",
            friendlyName: "Start Mop Drying",
            icon: "mdi:play",
            action: async () => this.capability.startDrying()
        });
        this.registerAction({
            topicName: "stop",
            friendlyName: "Stop Mop Drying",
            icon: "mdi:stop",
            action: async () => this.capability.stopDrying()
        });
    }

    /**
     * @private
     * @param {{topicName: string, friendlyName: string, icon: string, action: () => Promise<void>}} options
     */
    registerAction(options) {
        this.registerChild(new PropertyMqttHandle({
            parent: this,
            controller: this.controller,
            topicName: options.topicName,
            friendlyName: options.friendlyName,
            datatype: DataType.ENUM,
            format: Commands.BASIC.PERFORM,
            setter: options.action
        }).also((prop) => {
            this.controller.withHass((hass) => {
                prop.attachHomeAssistantComponent(new InLineHassComponent({
                    hass: hass,
                    robot: this.robot,
                    name: `${this.capability.getType()}_${options.topicName}`,
                    friendlyName: options.friendlyName,
                    componentType: ComponentType.BUTTON,
                    autoconf: {
                        command_topic: `${prop.getBaseTopic()}/set`,
                        payload_press: Commands.BASIC.PERFORM,
                        icon: options.icon,
                        entity_category: EntityCategory.CONFIG
                    }
                }));
            });
        }));
    }
}

MopDockDryManualTriggerCapabilityMqttHandle.OPTIONAL = false;

module.exports = MopDockDryManualTriggerCapabilityMqttHandle;

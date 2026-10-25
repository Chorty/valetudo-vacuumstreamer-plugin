const CapabilityMqttHandle = require("../../../backend/lib/mqtt/capabilities/CapabilityMqttHandle");
const Commands = require("../../../backend/lib/mqtt/common/Commands");
const ComponentType = require("../../../backend/lib/mqtt/homeassistant/ComponentType");
const DataType = require("../../../backend/lib/mqtt/homie/DataType");
const EntityCategory = require("../../../backend/lib/mqtt/homeassistant/EntityCategory");
const InLineHassComponent = require("../../../backend/lib/mqtt/homeassistant/components/InLineHassComponent");
const PropertyMqttHandle = require("../../../backend/lib/mqtt/handles/PropertyMqttHandle");

class QuirksCapabilityMqttHandle extends CapabilityMqttHandle {
    /**
     * @param {object} options
     * @param {import("../../../backend/lib/mqtt/handles/RobotMqttHandle")} options.parent
     * @param {import("../../../backend/lib/mqtt/MqttController")} options.controller
     * @param {import("../../../backend/lib/core/ValetudoRobot")} options.robot
     * @param {import("../../../backend/lib/core/capabilities/QuirksCapability")} options.capability
     */
    constructor(options) {
        super(Object.assign(options, {
            friendlyName: "Quirks"
        }));
        /** @type {import("../../../backend/lib/core/capabilities/QuirksCapability")} */
        this.capability = options.capability;

        /** @type {Map<string, {options: Array<string>, description: string, id: string, title: string, value: string}>|null} */
        this.quirksCache = null;
        this.quirksCacheTimestamp = 0;
        /** @type {Promise<Map<string, {options: Array<string>, description: string, id: string, title: string, value: string}>>|null} */
        this.quirksCachePromise = null;

        for (const quirk of this.capability.quirks ?? []) {
            if (quirk.mqttExposed === false) {
                continue;
            }
            if (isTriggerQuirk(quirk)) {
                this.registerTriggerQuirk(quirk);
            } else if (isToggleQuirk(quirk)) {
                this.registerToggleQuirk(quirk);
            } else {
                this.registerSelectQuirk(quirk);
            }
        }
    }

    /**
     * @private
     * @param {import("../../../backend/lib/core/Quirk")} quirk
     */
    registerTriggerQuirk(quirk) {
        this.registerChild(new PropertyMqttHandle({
            parent: this,
            controller: this.controller,
            topicName: quirk.id,
            friendlyName: quirk.title,
            datatype: DataType.ENUM,
            format: Commands.BASIC.PERFORM,
            setter: async () => {
                await this.capability.setQuirkValue(quirk.id, "trigger");
            },
            helpText: quirk.description
        }).also((prop) => {
            this.attachHassComponent(prop, quirk, ComponentType.BUTTON, {
                command_topic: `${prop.getBaseTopic()}/set`,
                payload_press: Commands.BASIC.PERFORM,
                icon: "mdi:play"
            });
        }));
    }

    /**
     * @private
     * @param {import("../../../backend/lib/core/Quirk")} quirk
     */
    registerToggleQuirk(quirk) {
        this.registerChild(new PropertyMqttHandle({
            parent: this,
            controller: this.controller,
            topicName: quirk.id,
            friendlyName: quirk.title,
            datatype: DataType.ENUM,
            format: quirk.options.join(","),
            setter: async (value) => {
                await this.setQuirkValue(quirk.id, value);
            },
            getter: async () => this.getQuirkValue(quirk.id),
            helpText: quirk.description
        }).also((prop) => {
            this.attachHassComponent(prop, quirk, ComponentType.SWITCH, {
                state_topic: prop.getBaseTopic(),
                command_topic: `${prop.getBaseTopic()}/set`,
                payload_off: "off",
                payload_on: "on",
                icon: "mdi:tune-variant"
            });
        }));
    }

    /**
     * @private
     * @param {import("../../../backend/lib/core/Quirk")} quirk
     */
    registerSelectQuirk(quirk) {
        this.registerChild(new PropertyMqttHandle({
            parent: this,
            controller: this.controller,
            topicName: quirk.id,
            friendlyName: quirk.title,
            datatype: DataType.ENUM,
            format: quirk.options.join(","),
            setter: async (value) => {
                await this.setQuirkValue(quirk.id, value);
            },
            getter: async () => this.getQuirkValue(quirk.id),
            helpText: quirk.description
        }).also((prop) => {
            this.attachHassComponent(prop, quirk, ComponentType.SELECT, {
                state_topic: prop.getBaseTopic(),
                command_topic: `${prop.getBaseTopic()}/set`,
                options: quirk.options,
                icon: "mdi:tune"
            });
        }));
    }

    /**
     * @private
     * @param {PropertyMqttHandle} prop
     * @param {import("../../../backend/lib/core/Quirk")} quirk
     * @param {string} componentType
     * @param {object} autoconf
     */
    attachHassComponent(prop, quirk, componentType, autoconf) {
        this.controller.withHass((hass) => {
            prop.attachHomeAssistantComponent(new InLineHassComponent({
                hass: hass,
                robot: this.robot,
                name: `quirk_${quirk.id}`,
                friendlyName: quirk.title,
                componentType: componentType,
                autoconf: Object.assign(autoconf, {
                    entity_category: EntityCategory.CONFIG
                })
            }));
        });
    }

    /**
     * @private
     * @param {string} id
     * @returns {Promise<string|null>}
     */
    async getQuirkValue(id) {
        const quirks = await this.getSerializedQuirks();
        return quirks.get(id)?.value ?? null;
    }

    /**
     * @private
     * @returns {Promise<Map<string, {options: Array<string>, description: string, id: string, title: string, value: string}>>}
     */
    async getSerializedQuirks() {
        if (this.quirksCache !== null && Date.now() - this.quirksCacheTimestamp < QUIRK_CACHE_TTL_MS) {
            return this.quirksCache;
        }

        if (this.quirksCachePromise === null) {
            this.quirksCachePromise = this.capability.getQuirks().then(quirks => {
                this.quirksCache = new Map(quirks.map(quirk => [quirk.id, quirk]));
                this.quirksCacheTimestamp = Date.now();
                return this.quirksCache;
            }).finally(() => {
                this.quirksCachePromise = null;
            });
        }

        return this.quirksCachePromise;
    }

    /**
     * @private
     * @param {string} id
     * @param {string} value
     * @returns {Promise<void>}
     */
    async setQuirkValue(id, value) {
        await this.capability.setQuirkValue(id, value);
        this.quirksCache = null;
        this.quirksCacheTimestamp = 0;
    }
}

/**
 * @param {import("../../../backend/lib/core/Quirk")} quirk
 * @returns {boolean}
 */
function isToggleQuirk(quirk) {
    return quirk.options.length === 2 && quirk.options.includes("on") && quirk.options.includes("off");
}

/**
 * @param {import("../../../backend/lib/core/Quirk")} quirk
 * @returns {boolean}
 */
function isTriggerQuirk(quirk) {
    return quirk.options.length === 2 && quirk.options.includes("select_to_trigger") && quirk.options.includes("trigger");
}

const QUIRK_CACHE_TTL_MS = 25 * 1000;

QuirksCapabilityMqttHandle.OPTIONAL = true;

module.exports = QuirksCapabilityMqttHandle;

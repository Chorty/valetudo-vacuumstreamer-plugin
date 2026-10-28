const DreameMopExtensionControlCapabilityV1 = require("../../backend/lib/robots/dreame/capabilities/DreameMopExtensionControlCapabilityV1");
const MopExtensionControlCapability = require("../../backend/lib/core/capabilities/MopExtensionControlCapability");
const OperationModeControlCapability = require("../../backend/lib/core/capabilities/OperationModeControlCapability");
const PresetSelectionStateAttribute = require("../../backend/lib/entities/state/attributes/PresetSelectionStateAttribute");
const ValetudoSelectionPreset = require("../../backend/lib/entities/core/ValetudoSelectionPreset");

const VACUUM_THEN_MOP_VALUE = 3;

/**
 * Overrides for this robot's firmware (L10S Pro Ultra Heat, firmware 1574) that
 * differ from upstream's model definition. They are not VacuumStreamer
 * features, so no vacuumstreamer.conf switch turns them off.
 *
 * Runs at the end of the robot's constructor, after upstream registered its
 * capabilities and before Valetudo builds routers and MQTT handles from them.
 *
 * @param {any} robot
 */
module.exports = function applyRobotOverrides(robot) {
    addVacuumThenMopPreset(robot);
    useMopExtensionControlV1(robot);
};

/**
 * Upstream removed the VACUUM_THEN_MOP operation mode (preset 3) from this
 * model in e42adcb7. On this robot it works: a user-started cleaning on
 * 2026-10-03 vacuumed, washed the mop mid-job, mopped, then ran the final wash.
 * The state parser reads robot.operationModes, and the capability its presets.
 *
 * @param {any} robot
 */
function addVacuumThenMopPreset(robot) {
    const mode = PresetSelectionStateAttribute.MODE.VACUUM_THEN_MOP;
    const capability = robot.capabilities[OperationModeControlCapability.TYPE];

    if (!capability || robot.operationModes[mode] !== undefined) {
        return;
    }

    robot.operationModes = Object.freeze(Object.assign({}, robot.operationModes, {[mode]: VACUUM_THEN_MOP_VALUE}));
    capability.presets.push(new ValetudoSelectionPreset({name: mode, value: VACUUM_THEN_MOP_VALUE}));
}

/**
 * Upstream 04bac60f moved this model to the V2 mop extension control
 * (MopExtrSwitch), which newer firmware uses. Firmware 1574 accepts V2 writes
 * but ignores them; it still uses the V1 MopScalable tunable.
 *
 * @param {any} robot
 */
function useMopExtensionControlV1(robot) {
    const current = robot.capabilities[MopExtensionControlCapability.TYPE];

    if (!current || current instanceof DreameMopExtensionControlCapabilityV1) {
        return;
    }

    delete robot.capabilities[MopExtensionControlCapability.TYPE];
    robot.registerCapability(new DreameMopExtensionControlCapabilityV1({robot: robot}));
}

module.exports.VACUUM_THEN_MOP_VALUE = VACUUM_THEN_MOP_VALUE;

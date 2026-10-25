const assert = require("node:assert/strict");
const test = require("node:test");

const applyRobotOverrides = require("../backend/RobotOverrides");
const DreameMopExtensionControlCapabilityV1 = require("../../backend/lib/robots/dreame/capabilities/DreameMopExtensionControlCapabilityV1");
const DreameMopExtensionControlCapabilityV2 = require("../../backend/lib/robots/dreame/capabilities/DreameMopExtensionControlCapabilityV2");
const DreameOperationModeControlCapability = require("../../backend/lib/robots/dreame/capabilities/DreameOperationModeControlCapability");
const MopExtensionControlCapability = require("../../backend/lib/core/capabilities/MopExtensionControlCapability");
const OperationModeControlCapability = require("../../backend/lib/core/capabilities/OperationModeControlCapability");
const PresetSelectionStateAttribute = require("../../backend/lib/entities/state/attributes/PresetSelectionStateAttribute");
const ValetudoRobot = require("../../backend/lib/core/ValetudoRobot");
const ValetudoSelectionPreset = require("../../backend/lib/entities/core/ValetudoSelectionPreset");

const MODE = PresetSelectionStateAttribute.MODE;

/**
 * A robot in the state upstream's DreameL10SProUltraHeatValetudoRobot leaves it
 * in: three operation modes and the V2 mop extension control, registered
 * through ValetudoRobot's own duplicate-checking registerCapability.
 *
 * @param {object} [options]
 * @param {boolean} [options.withCapabilities]
 */
function upstreamL10S(options = {}) {
    const robot = {
        capabilities: {},
        operationModes: Object.freeze({
            [MODE.VACUUM_AND_MOP]: 0,
            [MODE.MOP]: 1,
            [MODE.VACUUM]: 2,
        }),
        registerCapability: function(capability) {
            ValetudoRobot.prototype.registerCapability.call(this, capability);
        },
    };

    if (options.withCapabilities !== false) {
        robot.registerCapability(new DreameOperationModeControlCapability({
            robot: robot,
            presets: Object.keys(robot.operationModes).map(k => {
                return new ValetudoSelectionPreset({name: k, value: robot.operationModes[k]});
            }),
            siid: 4,
            piid: 23,
        }));
        robot.registerCapability(new DreameMopExtensionControlCapabilityV2({robot: robot}));
    }

    return robot;
}

test("adds preset 3 to both the state parser's map and the capability, in the fork's former order", () => {
    const robot = upstreamL10S();

    applyRobotOverrides(robot);

    assert.deepEqual(robot.operationModes, {
        [MODE.VACUUM_AND_MOP]: 0,
        [MODE.MOP]: 1,
        [MODE.VACUUM]: 2,
        [MODE.VACUUM_THEN_MOP]: 3,
    });
    assert.ok(Object.isFrozen(robot.operationModes));
    assert.deepEqual(
        robot.capabilities[OperationModeControlCapability.TYPE].getPresets(),
        [MODE.VACUUM_AND_MOP, MODE.MOP, MODE.VACUUM, MODE.VACUUM_THEN_MOP]
    );
});

test("replaces the V2 mop extension control with V1", () => {
    const robot = upstreamL10S();

    applyRobotOverrides(robot);

    const capability = robot.capabilities[MopExtensionControlCapability.TYPE];
    assert.ok(capability instanceof DreameMopExtensionControlCapabilityV1);
    assert.equal(capability.robot, robot);
});

test("is idempotent", () => {
    const robot = upstreamL10S();

    applyRobotOverrides(robot);
    const v1 = robot.capabilities[MopExtensionControlCapability.TYPE];
    applyRobotOverrides(robot);

    assert.equal(robot.capabilities[OperationModeControlCapability.TYPE].presets.length, 4);
    assert.equal(robot.capabilities[MopExtensionControlCapability.TYPE], v1);
});

test("leaves a robot without those capabilities untouched", () => {
    const robot = upstreamL10S({withCapabilities: false});
    const modes = robot.operationModes;

    applyRobotOverrides(robot);

    assert.equal(robot.operationModes, modes);
    assert.deepEqual(robot.capabilities, {});
});

test("upstream still defines the L10S without preset 3 and with the V2 mop extension control", () => {
    // If upstream changes either, revisit RobotOverrides.js rather than stacking on top of it.
    const source = require("node:fs").readFileSync(
        require.resolve("../../backend/lib/robots/dreame/DreameL10SProUltraHeatValetudoRobot.js"),
        "utf8"
    );

    assert.equal(source.includes("VACUUM_THEN_MOP"), false);
    assert.ok(source.includes("capabilities.DreameMopExtensionControlCapabilityV2"));
    assert.equal(source.includes("DreameMopExtensionControlCapabilityV1"), false);
});

const assert = require("node:assert/strict");
const test = require("node:test");

const applyRobotOverrides = require("../backend/RobotOverrides");
const DreameMopExtensionControlCapabilityV1 = require("../../backend/lib/robots/dreame/capabilities/DreameMopExtensionControlCapabilityV1");
const DreameMopExtensionControlCapabilityV2 = require("../../backend/lib/robots/dreame/capabilities/DreameMopExtensionControlCapabilityV2");
const DreameOperationModeControlCapability = require("../../backend/lib/robots/dreame/capabilities/DreameOperationModeControlCapability");
const DreameQuirkFactory = require("../../backend/lib/robots/dreame/DreameQuirkFactory");
const MopExtensionControlCapability = require("../../backend/lib/core/capabilities/MopExtensionControlCapability");
const OperationModeControlCapability = require("../../backend/lib/core/capabilities/OperationModeControlCapability");
const PresetSelectionStateAttribute = require("../../backend/lib/entities/state/attributes/PresetSelectionStateAttribute");
const QuirksCapability = require("../../backend/lib/core/capabilities/QuirksCapability");
const ValetudoRobot = require("../../backend/lib/core/ValetudoRobot");
const ValetudoSelectionPreset = require("../../backend/lib/entities/core/ValetudoSelectionPreset");

const MODE = PresetSelectionStateAttribute.MODE;
const EDGE_EXTENSION_FREQUENCY = DreameQuirkFactory.KNOWN_QUIRKS.EDGE_EXTENSION_FREQUENCY;

// MISC_TUNABLES as firmware 1574 reports it: no ExtrFreq.
const TUNABLES_WITHOUT_EXTR_FREQ = JSON.stringify([{k: "MopScalable", v: 1}]);

/**
 * A robot in the state upstream's DreameL10SProUltraHeatValetudoRobot leaves it
 * in: three operation modes, the V2 mop extension control and upstream's
 * edge-extension-frequency quirk, registered through ValetudoRobot's own
 * duplicate-checking registerCapability. miotHelper answers every property
 * read with options.tunables and counts the reads.
 *
 * @param {object} [options]
 * @param {boolean} [options.withCapabilities]
 * @param {string} [options.tunables]
 */
function upstreamL10S(options = {}) {
    const robot = {
        capabilities: {},
        reads: 0,
        miotHelper: {
            readProperty: async () => {
                robot.reads++;
                return options.tunables ?? TUNABLES_WITHOUT_EXTR_FREQ;
            },
        },
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
        robot.registerCapability(new QuirksCapability({
            robot: robot,
            quirks: [new DreameQuirkFactory({robot: robot}).getQuirk(EDGE_EXTENSION_FREQUENCY)],
        }));
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

test("keeps the edge-extension-frequency quirk listed, with a null value, when the firmware omits ExtrFreq", async () => {
    const robot = upstreamL10S();

    applyRobotOverrides(robot);

    const quirks = await robot.capabilities[QuirksCapability.TYPE].getQuirks();
    assert.deepEqual(quirks.map(q => [q.id, q.value]), [[EDGE_EXTENSION_FREQUENCY, null]]);
    assert.equal(robot.reads, 1);
});

test("leaves a reported ExtrFreq to upstream's getter", async () => {
    for (const [extrFreq, expected] of [[1, "automatic"], [2, "each_cleanup"], [7, "every_7_days"]]) {
        const robot = upstreamL10S({tunables: JSON.stringify([{k: "ExtrFreq", v: extrFreq}])});

        applyRobotOverrides(robot);

        const quirks = await robot.capabilities[QuirksCapability.TYPE].getQuirks();
        assert.deepEqual(quirks.map(q => q.value), [expected]);
    }

    const robot = upstreamL10S({tunables: JSON.stringify([{k: "ExtrFreq", v: 3}])});
    applyRobotOverrides(robot);
    await assert.rejects(robot.capabilities[QuirksCapability.TYPE].quirks[0].getter(), /Received invalid value 3/);
});

test("upstream's edge-extension-frequency getter still throws when the firmware omits ExtrFreq", async () => {
    // If upstream starts tolerating it, drop tolerateMissingEdgeExtensionFrequency.
    const robot = upstreamL10S();

    await assert.rejects(robot.capabilities[QuirksCapability.TYPE].quirks[0].getter(), /Received invalid value undefined/);
    assert.deepEqual(await robot.capabilities[QuirksCapability.TYPE].getQuirks(), []);
});

test("is idempotent", async () => {
    const robot = upstreamL10S();

    applyRobotOverrides(robot);
    const v1 = robot.capabilities[MopExtensionControlCapability.TYPE];
    const getter = robot.capabilities[QuirksCapability.TYPE].quirks[0].getter;
    applyRobotOverrides(robot);

    assert.equal(robot.capabilities[OperationModeControlCapability.TYPE].presets.length, 4);
    assert.equal(robot.capabilities[MopExtensionControlCapability.TYPE], v1);
    assert.equal(robot.capabilities[QuirksCapability.TYPE].quirks[0].getter, getter);
    assert.equal(await getter(), null);
    assert.equal(robot.reads, 1);
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

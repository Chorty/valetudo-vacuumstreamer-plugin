const assert = require("node:assert/strict");
const test = require("node:test");

const Commands = require("../../backend/lib/mqtt/common/Commands");
const ComponentType = require("../../backend/lib/mqtt/homeassistant/ComponentType");
const MicrophoneGainCapability = require("../backend/core-capabilities/MicrophoneGainCapability");
const MicrophoneGainCapabilityMqttHandle = require("../backend/mqtt/MicrophoneGainCapabilityMqttHandle");
const RecorderQualityCapability = require("../backend/core-capabilities/RecorderQualityCapability");
const RecorderQualityCapabilityMqttHandle = require("../backend/mqtt/RecorderQualityCapabilityMqttHandle");
const TextToSpeechCapability = require("../backend/core-capabilities/TextToSpeechCapability");
const TextToSpeechCapabilityMqttHandle = require("../backend/mqtt/TextToSpeechCapabilityMqttHandle");
const VideoStreamCapability = require("../backend/core-capabilities/VideoStreamCapability");
const VideoStreamCapabilityMqttHandle = require("../backend/mqtt/VideoStreamCapabilityMqttHandle");

function createHandle(Handle, capability) {
    const hass = {
        identifier: "test_robot",
        objectId: "test_robot"
    };
    const controller = {
        isInitialized: false,
        refresh: async () => undefined,
        withHass: callback => callback(hass)
    };
    const parent = {
        getBaseTopic: () => "valetudo/TestRobot"
    };

    return new Handle({
        parent: parent,
        controller: controller,
        robot: {},
        capability: capability
    });
}

function child(handle, topicName) {
    return handle.children.find(item => item.topicName === topicName);
}

test("exports MQTT mappings for the plugin capabilities", () => {
    const mappings = require("../backend/VacuumstreamerMqttHandleMappings");

    assert.equal(mappings[TextToSpeechCapability.TYPE], TextToSpeechCapabilityMqttHandle);
    assert.equal(mappings[VideoStreamCapability.TYPE], VideoStreamCapabilityMqttHandle);
    assert.equal(mappings[MicrophoneGainCapability.TYPE], MicrophoneGainCapabilityMqttHandle);
    assert.equal(mappings[RecorderQualityCapability.TYPE], RecorderQualityCapabilityMqttHandle);
});

test("plugin MQTT handles are never OPTIONAL, since their capability types can't be added to the parent's generated optionalExposedCapabilities enum from here", () => {
    assert.equal(TextToSpeechCapabilityMqttHandle.OPTIONAL, false);
    assert.equal(VideoStreamCapabilityMqttHandle.OPTIONAL, false);
    assert.equal(MicrophoneGainCapabilityMqttHandle.OPTIONAL, false);
    assert.equal(RecorderQualityCapabilityMqttHandle.OPTIONAL, false);
});

test("TTS handle exposes a Home Assistant notify entity and invokes speak", async () => {
    const spoken = [];
    const capability = {
        getType: () => TextToSpeechCapability.TYPE,
        speak: async text => spoken.push(text),
        getStatus: async () => ({speaking: false}),
        stopAudio: async () => undefined,
        onSpeakingChanged: () => undefined
    };
    const handle = createHandle(TextToSpeechCapabilityMqttHandle, capability);
    const speak = child(handle, "speak");

    await speak.set("Dinner is ready");

    assert.deepEqual(spoken, ["Dinner is ready"]);
    assert.equal(speak.hassComponents.length, 1);
    assert.equal(speak.hassComponents[0].componentType, ComponentType.NOTIFY);
    assert.equal(
        speak.hassComponents[0].getAutoconf().command_topic,
        "valetudo/TestRobot/TextToSpeechCapability/speak/set"
    );
});

test("TTS handle reports speaking state and stops audio", async () => {
    let stopped = false;
    const capability = {
        getType: () => TextToSpeechCapability.TYPE,
        speak: async () => undefined,
        getStatus: async () => ({speaking: true}),
        stopAudio: async () => {
            stopped = true;
        },
        onSpeakingChanged: () => undefined
    };
    const handle = createHandle(TextToSpeechCapabilityMqttHandle, capability);

    assert.equal(await child(handle, "speaking").get(), true);
    await child(handle, "stop").set(Commands.BASIC.PERFORM);
    assert.equal(stopped, true);
});

test("TTS handle publishes the speaking property immediately on every transition, not just on the periodic poll", async () => {
    let speaking = false;
    let listener;
    const refreshedBaseTopics = [];
    const capability = {
        getType: () => TextToSpeechCapability.TYPE,
        speak: async () => undefined,
        getStatus: async () => ({speaking: speaking}),
        stopAudio: async () => undefined,
        onSpeakingChanged: cb => {
            listener = cb;
        }
    };
    const controller = {
        isInitialized: false,
        refresh: async handle => {
            refreshedBaseTopics.push(handle.getBaseTopic());
        },
        // No Home Assistant component is attached in this test, so refresh()
        // only needs to exercise the raw MQTT publish path above.
        withHass: () => undefined
    };
    const parent = {
        getBaseTopic: () => "valetudo/TestRobot"
    };

    const handle = new TextToSpeechCapabilityMqttHandle({
        parent: parent,
        controller: controller,
        robot: {},
        capability: capability
    });

    assert.equal(typeof listener, "function", "the handle must register a speakingChanged listener");

    speaking = true;
    listener(true);
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(refreshedBaseTopics, ["valetudo/TestRobot/TextToSpeechCapability/speaking"]);

    speaking = false;
    listener(false);
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(refreshedBaseTopics, [
        "valetudo/TestRobot/TextToSpeechCapability/speaking",
        "valetudo/TestRobot/TextToSpeechCapability/speaking"
    ]);
    assert.equal(handle.children.find(item => item.topicName === "speaking"), handle.speakingProperty);
});

test("video handle starts and stops the stream and reports its state", async () => {
    const calls = [];
    let active = false;
    const capability = {
        getType: () => VideoStreamCapability.TYPE,
        getStreamStatus: async () => ({active: active}),
        startStream: async () => {
            calls.push("start");
            active = true;
        },
        stopStream: async () => {
            calls.push("stop");
            active = false;
        },
        getStreamURLs: async () => ({
            rtsp: "rtsp://robot:8554/vacuum",
            webrtc: "http://robot:1984/stream.html?src=vacuum"
        })
    };
    const handle = createHandle(VideoStreamCapabilityMqttHandle, capability);
    const enabled = child(handle, "enabled");

    assert.equal(await enabled.get(), Commands.SWITCH.OFF);
    await enabled.setter(Commands.SWITCH.ON);
    assert.equal(await enabled.get(), Commands.SWITCH.ON);
    await enabled.setter(Commands.SWITCH.OFF);

    assert.deepEqual(calls, ["start", "stop"]);
    assert.equal(enabled.hassComponents[0].componentType, ComponentType.SWITCH);
    assert.equal(await child(handle, "rtsp_url").get(), "rtsp://robot:8554/vacuum");
    assert.equal(await child(handle, "webrtc_url").get(), "http://robot:1984/stream.html?src=vacuum");
});

test("video handle rejects unsupported switch commands", async () => {
    const capability = {
        getType: () => VideoStreamCapability.TYPE,
        getStreamStatus: async () => ({active: false}),
        startStream: async () => undefined,
        stopStream: async () => undefined,
        getStreamURLs: async () => ({})
    };
    const handle = createHandle(VideoStreamCapabilityMqttHandle, capability);

    await assert.rejects(child(handle, "enabled").setter("INVALID"), /Invalid value/);
});

test("mic gain handle exposes a Home Assistant number entity and reports/sets the value", async () => {
    let gain = 61;
    const capability = {
        getType: () => MicrophoneGainCapability.TYPE,
        getProperties: () => ({min: 0, max: 100}),
        getGain: async () => gain,
        setGain: async value => {
            gain = value;
        }
    };
    const handle = createHandle(MicrophoneGainCapabilityMqttHandle, capability);
    const value = child(handle, "value");

    assert.equal(await value.get(), 61);
    await value.setter(75);
    assert.equal(gain, 75);
    assert.equal(value.hassComponents[0].componentType, ComponentType.NUMBER);
    assert.equal(
        value.hassComponents[0].getAutoconf().command_topic,
        "valetudo/TestRobot/MicrophoneGainCapability/value/set"
    );
});

test("mic gain handle rejects a value outside the advertised range", async () => {
    const capability = {
        getType: () => MicrophoneGainCapability.TYPE,
        getProperties: () => ({min: 0, max: 100}),
        getGain: async () => 0,
        setGain: async () => undefined
    };
    const handle = createHandle(MicrophoneGainCapabilityMqttHandle, capability);

    await assert.rejects(child(handle, "value").setter(101), /Invalid microphone gain/);
});

test("recorder quality handle exposes a Home Assistant select entity and reports/sets the profile", async () => {
    let profile = "low";
    const capability = {
        getType: () => RecorderQualityCapability.TYPE,
        getProperties: () => ({supportedProfiles: ["low", "high"]}),
        getQuality: async () => ({profile: profile, width: 864, height: 480, framerate: 15, bitrate: 600000}),
        setQuality: async value => {
            profile = value;
        }
    };
    const handle = createHandle(RecorderQualityCapabilityMqttHandle, capability);
    const property = child(handle, "profile");

    assert.equal(await property.get(), "low");
    await property.setter("high");
    assert.equal(profile, "high");
    assert.equal(property.hassComponents[0].componentType, ComponentType.SELECT);
    assert.deepEqual(property.hassComponents[0].getAutoconf().options, ["low", "high"]);
});

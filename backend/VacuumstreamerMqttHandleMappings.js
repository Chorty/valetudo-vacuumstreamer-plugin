const capabilities = require("./core-capabilities");
const MopDockCleanManualTriggerCapability = require("../../backend/lib/core/capabilities/MopDockCleanManualTriggerCapability");
const MopDockDryManualTriggerCapability = require("../../backend/lib/core/capabilities/MopDockDryManualTriggerCapability");
const mqttHandles = require("./mqtt");
const QuirksCapability = require("../../backend/lib/core/capabilities/QuirksCapability");

module.exports = {
    [capabilities.TextToSpeechCapability.TYPE]: mqttHandles.TextToSpeechCapabilityMqttHandle,
    [capabilities.VideoStreamCapability.TYPE]: mqttHandles.VideoStreamCapabilityMqttHandle,
    [capabilities.MicrophoneGainCapability.TYPE]: mqttHandles.MicrophoneGainCapabilityMqttHandle,
    [capabilities.RecorderQualityCapability.TYPE]: mqttHandles.RecorderQualityCapabilityMqttHandle,
    // Core capabilities that upstream exposes over REST only.
    [MopDockCleanManualTriggerCapability.TYPE]: mqttHandles.MopDockCleanManualTriggerCapabilityMqttHandle,
    [MopDockDryManualTriggerCapability.TYPE]: mqttHandles.MopDockDryManualTriggerCapabilityMqttHandle,
    [QuirksCapability.TYPE]: mqttHandles.QuirksCapabilityMqttHandle,
};

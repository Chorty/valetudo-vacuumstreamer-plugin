const capabilities = require("./core-capabilities");
const mqttHandles = require("./mqtt");

module.exports = {
    [capabilities.TextToSpeechCapability.TYPE]: mqttHandles.TextToSpeechCapabilityMqttHandle,
    [capabilities.VideoStreamCapability.TYPE]: mqttHandles.VideoStreamCapabilityMqttHandle,
    [capabilities.MicrophoneGainCapability.TYPE]: mqttHandles.MicrophoneGainCapabilityMqttHandle,
    [capabilities.RecorderQualityCapability.TYPE]: mqttHandles.RecorderQualityCapabilityMqttHandle,
};

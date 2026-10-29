const capabilities = require("../../backend/lib/core/capabilities");
const capabilityRouters = require("../../backend/lib/webserver/capabilityRouters");

// Applied after upstream's entries in CapabilitiesRouter.js, so an entry here replaces upstream's router.
module.exports = {
    [capabilities.VideoStreamCapability.TYPE]: capabilityRouters.VideoStreamCapabilityRouter,
    [capabilities.TextToSpeechCapability.TYPE]: capabilityRouters.TextToSpeechCapabilityRouter,
    [capabilities.MapManagementCapability.TYPE]: capabilityRouters.MapManagementCapabilityRouter,
    [capabilities.MicrophoneGainCapability.TYPE]: capabilityRouters.MicrophoneGainCapabilityRouter,
    [capabilities.RecorderQualityCapability.TYPE]: capabilityRouters.RecorderQualityCapabilityRouter,
    [capabilities.VoicePackManagementCapability.TYPE]: capabilityRouters.GuardedVoicePackManagementCapabilityRouter,
};

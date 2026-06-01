const capabilities = require("../../backend/lib/core/capabilities");
const capabilityRouters = require("../../backend/lib/webserver/capabilityRouters");

module.exports = {
    [capabilities.VideoStreamCapability.TYPE]: capabilityRouters.VideoStreamCapabilityRouter,
    [capabilities.TextToSpeechCapability.TYPE]: capabilityRouters.TextToSpeechCapabilityRouter,
    [capabilities.MapManagementCapability.TYPE]: capabilityRouters.MapManagementCapabilityRouter,
};

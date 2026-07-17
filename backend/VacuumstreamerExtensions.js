const capabilities = require("./dreame-capabilities");

module.exports = function registerVacuumstreamerCapabilities(robot) {
    robot.registerCapability(new capabilities.DreameVideoStreamCapability({
        robot: robot,
        streamConfig: {
            vacuumstreamerPath: "/data/vacuumstreamer/vacuumstreamer.so",
            go2rtcPath: "/data/vacuumstreamer/go2rtc",
            go2rtcConfigPath: "/data/vacuumstreamer/go2rtc.yaml",
            videoMonitorPath: "/data/vacuumstreamer/video_monitor",
            udpPort: 6969,
            go2rtcApiPort: 1984,
        },
    }));

    robot.registerCapability(new capabilities.DreameTextToSpeechCapability({
        robot: robot,
        ttsConfig: {
            tempDir: "/tmp",
            playerCommand: "aplay",
            defaultLanguage: "en",
            maxTextLength: 200,
        },
    }));

    robot.registerCapability(new capabilities.DreameMapManagementCapability({
        robot: robot,
        mapConfig: {
            storagePath: "/data/maploader",
            mapDirs: ["/data/ri", "/data/map", "/data/DivideMap"],
            multMapConfig: "/data/config/ava/mult_map.json",
        },
    }));
};

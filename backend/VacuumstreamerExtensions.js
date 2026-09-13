const capabilities = require("./dreame-capabilities");
const Logger = require("../../backend/lib/Logger");
const {loadVacuumstreamerConfig} = require("./VacuumstreamerConfig");

const CAPABILITY_SWITCHES = Object.freeze(["CAMERA", "TTS", "MAP_MANAGEMENT"]);

/**
 * Registers the VacuumStreamer capabilities that are switched on in
 * vacuumstreamer.conf. A capability that is switched off is not registered, so
 * its REST routes, MQTT topics and Home Assistant entities are absent.
 *
 * @param {any} robot
 * @param {object} [options]
 * @param {() => import("./VacuumstreamerConfig").VacuumstreamerConfig} [options.loadConfig]
 */
module.exports = function registerVacuumstreamerCapabilities(robot, options = {}) {
    const config = (options.loadConfig ?? loadVacuumstreamerConfig)();

    for (const warning of config.warnings) {
        Logger.warn(`VacuumStreamer: ${warning}`);
    }

    if (config.switches.CAMERA) {
        robot.registerCapability(new capabilities.DreameVideoStreamCapability({
            robot: robot,
            streamConfig: {
                vacuumstreamerPath: "/data/vacuumstreamer/vacuumstreamer.so",
                go2rtcPath: "/data/vacuumstreamer/go2rtc",
                go2rtcConfigPath: "/data/vacuumstreamer/go2rtc.yaml",
                videoMonitorPath: "/data/vacuumstreamer/video_monitor",
                go2rtcLauncherPath: "/data/vacuumstreamer/go2rtc_launch.sh",
                videoMonitorLauncherPath: "/data/vacuumstreamer/video_monitor_launch.sh",
                udpPort: 6969,
                go2rtcApiPort: 1984,
            },
        }));
    }

    if (config.switches.TTS) {
        robot.registerCapability(new capabilities.DreameTextToSpeechCapability({
            robot: robot,
            ttsConfig: {
                tempDir: "/tmp",
                playerCommand: "aplay",
                defaultLanguage: "en",
                maxTextLength: 200,
            },
        }));
    }

    if (config.switches.MAP_MANAGEMENT) {
        robot.registerCapability(new capabilities.DreameMapManagementCapability({
            robot: robot,
            mapConfig: {
                storagePath: "/data/maploader",
                mapDirs: ["/data/ri", "/data/map", "/data/DivideMap"],
                multMapConfig: "/data/config/ava/mult_map.json",
            },
        }));
    }

    const switchedOff = CAPABILITY_SWITCHES.filter(name => !config.switches[name]);

    if (switchedOff.length > 0) {
        Logger.info(`VacuumStreamer: switched off in ${config.path}: ${switchedOff.join(", ")}`);
    }
};

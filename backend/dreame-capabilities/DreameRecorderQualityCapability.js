const RecorderQualityCapability = require("../core-capabilities/RecorderQualityCapability");
const {runNativeScriptJson, sanitizedScriptEnv} = require("./runNativeScript");

/**
 * Dreame-specific recorder quality capability.
 *
 * Delegates to recorder_quality_ctl.sh, which edits the vendor video_monitor's
 * recorder.cfg and, if capture is currently active, restarts video_monitor
 * through video_monitor_launch.sh so it lands at Valetudo's own absolute nice
 * level instead of the default.
 *
 * @extends RecorderQualityCapability<import("../../../backend/lib/robots/dreame/DreameValetudoRobot")>
 */
class DreameRecorderQualityCapability extends RecorderQualityCapability {
    /**
     * @param {object} options
     * @param {import("../../../backend/lib/robots/dreame/DreameValetudoRobot")} options.robot
     * @param {object} [options.scriptConfig]
     * @param {string} [options.scriptConfig.recorderQualityCtlPath] - Native script that reads and sets recorder quality
     */
    constructor(options) {
        super(options);

        const defaults = {
            recorderQualityCtlPath: "/data/vacuumstreamer/recorder_quality_ctl.sh",
        };

        this.scriptConfig = Object.assign({}, defaults, options.scriptConfig || {});
    }

    /**
     * @returns {Promise<import("../core-capabilities/RecorderQualityCapability").RecorderQualityStatus>}
     */
    async getQuality() {
        return this._runRecorderQualityCtl(["get"]);
    }

    /**
     * @param {string} profile
     * @returns {Promise<import("../core-capabilities/RecorderQualityCapability").RecorderQualityStatus>}
     */
    async setQuality(profile) {
        if (!this.getProperties().supportedProfiles.includes(profile)) {
            throw new Error(`Unsupported recorder quality profile: ${profile}`);
        }

        return this._runRecorderQualityCtl(["set", profile]);
    }

    /**
     * @private
     * @param {string[]} args
     * @returns {Promise<import("../core-capabilities/RecorderQualityCapability").RecorderQualityStatus>}
     */
    _runRecorderQualityCtl(args) {
        return runNativeScriptJson("recorder_quality_ctl", this.scriptConfig.recorderQualityCtlPath, args, {
            // A "set" call may wait for the camera lock (up to
            // CAMERA_WAKE_TIMEOUT_SECONDS, default 15s), settle for a second,
            // then wait again for video_monitor's port to listen (up to the
            // same timeout) -- comfortably exceed that worst case here.
            timeout: 35000,
            env: sanitizedScriptEnv(),
        });
    }
}

module.exports = DreameRecorderQualityCapability;

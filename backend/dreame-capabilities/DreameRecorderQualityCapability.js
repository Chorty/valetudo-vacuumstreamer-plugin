const RecorderQualityCapability = require("../core-capabilities/RecorderQualityCapability");
const {execFile} = require("child_process");

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
        return new Promise((resolve, reject) => {
            execFile(this.scriptConfig.recorderQualityCtlPath, args, {
                // A "set" call may restart video_monitor, which itself waits on
                // vs_stop's grace period before the launch even begins.
                timeout: 15000,
            }, (error, stdout, stderr) => {
                if (error) {
                    const detail = String(stderr).trim() || error.message;
                    const wrapped = new Error(`recorder_quality_ctl ${args[0]} failed: ${detail}`);

                    if (error.code) {
                        Object.assign(wrapped, {code: error.code});
                    }

                    reject(wrapped);
                    return;
                }

                try {
                    resolve(JSON.parse(stdout));
                } catch (e) {
                    reject(new Error(`recorder_quality_ctl ${args[0]} returned invalid JSON: ${stdout}`));
                }
            });
        });
    }
}

module.exports = DreameRecorderQualityCapability;

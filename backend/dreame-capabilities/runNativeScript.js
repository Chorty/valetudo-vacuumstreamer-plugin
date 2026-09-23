const {execFile} = require("child_process");

const SENSITIVE_ENV_VARS = ["LD_PRELOAD", "CREDENTIALS_DIRECTORY", "GO2RTC_USERNAME", "GO2RTC_PASSWORD"];

/**
 * Runs a native VacuumStreamer script and parses its stdout as JSON.
 *
 * A failure is wrapped with `name` (used only for the error message, e.g.
 * "mic_gain_ctl") and the script's own stderr detail, preserving the
 * original error's `code` (e.g. "ENOENT" for a missing script) for callers
 * that want to distinguish that from a script-reported failure.
 *
 * @param {string} name - Used only in error messages, e.g. "mic_gain_ctl"
 * @param {string} scriptPath
 * @param {string[]} args
 * @param {object} [options]
 * @param {number} [options.timeout]
 * @param {Object<string, string>} [options.env] - Passed through to execFile; the default (unset) inherits process.env
 * @returns {Promise<any>}
 */
function runNativeScriptJson(name, scriptPath, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(scriptPath, args, {
            timeout: options.timeout,
            env: options.env,
        }, (error, stdout, stderr) => {
            if (error) {
                const detail = String(stderr).trim() || error.message;
                const wrapped = new Error(`${name} ${args[0]} failed: ${detail}`);

                if (error.code) {
                    Object.assign(wrapped, {code: error.code});
                }

                reject(wrapped);
                return;
            }

            try {
                resolve(JSON.parse(stdout));
            } catch (e) {
                reject(new Error(`${name} ${args[0]} returned invalid JSON: ${stdout}`));
            }
        });
    });
}

/**
 * process.env with the native camera pipeline's LD_PRELOAD hook and go2rtc
 * credentials removed, so a native script that doesn't itself need them
 * (unlike camera_ctl.sh, which sets its own) doesn't inherit them
 * unnecessarily. Mirrors DreameVideoStreamCapability's own _scriptEnv().
 *
 * @returns {Object<string, string>}
 */
function sanitizedScriptEnv() {
    const env = Object.assign({}, process.env);

    for (const name of SENSITIVE_ENV_VARS) {
        delete env[name];
    }

    return env;
}

module.exports = {runNativeScriptJson: runNativeScriptJson, sanitizedScriptEnv: sanitizedScriptEnv};

const fs = require("fs");
const Logger = require("../../../backend/lib/Logger");
const os = require("os");
const VideoStreamCapability = require("../core-capabilities/VideoStreamCapability");
const {execFile, execSync, spawn} = require("child_process");

/**
 * Dreame-specific video stream capability.
 *
 * Manages the video pipeline:
 *   1. vacuumstreamer.so — LD_PRELOAD shim that intercepts Agora RTC video frames
 *      and pushes raw H.264 NALUs over UDP to localhost:6969
 *   2. go2rtc — receives the UDP stream and re-publishes as RTSP/WebRTC/HLS
 *
 * The vacuumstreamer .so hooks into the vendor's `video_monitor` binary to capture
 * the camera feed without modifying the stock firmware binary.
 *
 * Installs with the native camera_ctl.sh delegate start and stop to it, which
 * applies the runtime switches and camera login and captures on demand. Older
 * installs start and stop the binaries directly.
 *
 * @extends VideoStreamCapability<import("../../../backend/lib/robots/dreame/DreameValetudoRobot")>
 */
class DreameVideoStreamCapability extends VideoStreamCapability {
    /**
     * @param {object} options
     * @param {import("../../../backend/lib/robots/dreame/DreameValetudoRobot")} options.robot
     * @param {object} [options.streamConfig]
     * @param {string} [options.streamConfig.vacuumstreamerPath] - Path to vacuumstreamer.so on vacuum
     * @param {string} [options.streamConfig.go2rtcPath] - Path to go2rtc binary on vacuum
     * @param {string} [options.streamConfig.go2rtcConfigPath] - Path to go2rtc.yaml config
     * @param {string} [options.streamConfig.videoMonitorPath] - Path to video_monitor binary
     * @param {number} [options.streamConfig.udpPort] - UDP port for H.264 stream (default: 6969)
     * @param {number} [options.streamConfig.go2rtcApiPort] - go2rtc API port (default: 1984)
     * @param {string} [options.streamConfig.libcPath] - Path to libc.so.6 override
     * @param {string} [options.streamConfig.cameraCtlPath] - Native script that starts, pauses and reports the camera
     * @param {string} [options.streamConfig.pausedFlagPath] - File camera_ctl.sh creates while the camera is paused
     * @param {string} [options.streamConfig.cameraMode] - CAMERA_MODE from vacuumstreamer.conf, reported in the status
     */
    constructor(options) {
        super(options);

        const defaults = {
            vacuumstreamerPath: "/data/vacuumstreamer/vacuumstreamer.so",
            go2rtcPath: "/data/vacuumstreamer/go2rtc",
            go2rtcConfigPath: "/data/vacuumstreamer/go2rtc.yaml",
            videoMonitorPath: "/data/vacuumstreamer/video_monitor",
            udpPort: 6969,
            go2rtcApiPort: 1984,
            libcPath: "/data/vacuumstreamer/libc.so.6",
            cameraCtlPath: "/data/vacuumstreamer/camera_ctl.sh",
            pausedFlagPath: "/tmp/vacuumstreamer/camera_paused",
            cameraMode: "on_demand",
        };

        this.streamConfig = Object.assign({}, defaults, options.streamConfig || {});

        // Track child processes
        this._videoMonitorProc = null;
        this._go2rtcProc = null;
        // Status cache to avoid repeated pidof shell spawns on rapid polls
        this._statusCache = null;
        this._statusCacheTs = 0;
        this._lifecycleQueue = Promise.resolve();
        this._legacyLaunchWarningLogged = false;
    }

    /**
     * @returns {Promise<import("../core-capabilities/VideoStreamCapability").VideoStreamStatus>}
     */
    async getStreamStatus() {
        const now = Date.now();
        if (this._statusCache !== null && now - this._statusCacheTs < 1000) {
            return this._statusCache;
        }

        const videoMonitorPid = this._getPidOf("video_monitor");
        const go2rtcPid = this._getPidOf("go2rtc");

        if (this._cameraCtlAvailable()) {
            const paused = fs.existsSync(this.streamConfig.pausedFlagPath);

            // On-demand capture leaves video_monitor stopped until someone watches
            this._statusCache = {
                active: go2rtcPid !== null && !paused,
                capturing: videoMonitorPid !== null,
                paused: paused,
                mode: this.streamConfig.cameraMode,
                pid: videoMonitorPid,
                go2rtcPid: go2rtcPid,
            };
        } else {
            this._statusCache = {
                active: videoMonitorPid !== null && go2rtcPid !== null,
                pid: videoMonitorPid,
                go2rtcPid: go2rtcPid,
            };
        }
        this._statusCacheTs = now;

        return this._statusCache;
    }

    /**
     * @returns {Promise<void>}
     */
    async startStream() {
        return this._enqueueLifecycleOperation(async () => {
            try {
                await this._startStream();
            } finally {
                this._statusCache = null;
            }
        });
    }

    /**
     * @private
     * @returns {Promise<void>}
     */
    async _startStream() {
        if (this._cameraCtlAvailable()) {
            Logger.info("Starting video stream through camera_ctl.sh...");
            await this._runCameraCtl("start");
            Logger.info("Video stream started");
            return;
        }

        if (!this._legacyLaunchWarningLogged) {
            Logger.warn("VacuumStreamer camera_ctl.sh not found; starting the binaries directly without switch or login checks");
            this._legacyLaunchWarningLogged = true;
        }

        this._statusCache = null; // Invalidate cache before checking live state
        const status = await this.getStreamStatus();
        if (status.active) {
            Logger.info("Video stream already active, skipping start");
            return;
        }

        Logger.info("Starting video stream pipeline...");

        // Step 1: Kill any existing video_monitor processes
        this._killProcess("video_monitor");

        // Step 2: Start go2rtc if not already running
        const go2rtcPid = this._getPidOf("go2rtc");
        if (go2rtcPid === null) {
            Logger.info("Starting go2rtc...");
            try {
                this._go2rtcProc = await this._spawnDetached(this.streamConfig.go2rtcPath, [
                    "-config", this.streamConfig.go2rtcConfigPath
                ], {
                    detached: true,
                    stdio: "ignore",
                    env: Object.assign({}, process.env),
                }, "go2rtc");

                // Give go2rtc a moment to start
                await this._sleep(1000);
            } catch (e) {
                Logger.error("Failed to start go2rtc", e);
                throw e;
            }
        }

        // Step 3: Start video_monitor with LD_PRELOAD
        Logger.info("Starting video_monitor with vacuumstreamer.so...");
        try {
            const env = Object.assign({}, process.env, {
                LD_PRELOAD: this.streamConfig.vacuumstreamerPath,
            });

            // If a custom libc is needed (for older firmware)
            if (this.streamConfig.libcPath && fs.existsSync(this.streamConfig.libcPath)) {
                env.LD_PRELOAD = `${this.streamConfig.vacuumstreamerPath}:${this.streamConfig.libcPath}`;
            }

            this._videoMonitorProc = await this._spawnDetached(this.streamConfig.videoMonitorPath, [], {
                detached: true,
                stdio: "ignore",
                env: env,
            }, "video_monitor");

            Logger.info("Video stream pipeline started successfully");
        } catch (e) {
            Logger.error("Failed to start video_monitor", e);
            throw e;
        }
    }

    /**
     * Start a detached child and reject on spawn failures instead of letting an
     * unhandled ChildProcess error terminate Valetudo.
     *
     * @private
     * @param {string} command
     * @param {string[]} args
     * @param {import("child_process").SpawnOptions} options
     * @param {string} label
     * @returns {Promise<import("child_process").ChildProcess>}
     */
    async _spawnDetached(command, args, options, label) {
        const child = spawn(command, args, options);

        await new Promise((resolve, reject) => {
            const onError = error => {
                child.removeListener("spawn", onSpawn);
                reject(error);
            };
            const onSpawn = () => {
                child.removeListener("error", onError);
                resolve();
            };

            child.once("error", onError);
            child.once("spawn", onSpawn);
        });
        child.on("error", error => {
            Logger.error(label + " process error", error);
        });
        child.unref();

        return child;
    }

    /**
     * @returns {Promise<void>}
     */
    async stopStream() {
        return this._enqueueLifecycleOperation(async () => {
            try {
                await this._stopStream();
            } finally {
                this._statusCache = null;
            }
        });
    }

    /**
     * @private
     * @returns {Promise<void>}
     */
    async _stopStream() {
        if (this._cameraCtlAvailable()) {
            Logger.info("Pausing video stream through camera_ctl.sh...");
            await this._runCameraCtl("stop");
            this._videoMonitorProc = null;
            this._go2rtcProc = null;
            Logger.info("Video stream paused");
            return;
        }

        Logger.info("Stopping video stream pipeline...");

        // Kill via stored handles first (targeted), then killall as safety net for untracked instances
        if (this._videoMonitorProc) {
            try {
                this._videoMonitorProc.kill();
            } catch (_) {
                // It may already have exited.
            }
            this._videoMonitorProc = null;
        }
        if (this._go2rtcProc) {
            try {
                this._go2rtcProc.kill();
            } catch (_) {
                // It may already have exited.
            }
            this._go2rtcProc = null;
        }
        this._killProcess("video_monitor");
        this._killProcess("go2rtc");

        this._statusCache = null; // Invalidate cache after state change

        Logger.info("Video stream pipeline stopped");
    }

    /**
     * @private
     * @template T
     * @param {() => Promise<T>} operation
     * @returns {Promise<T>}
     */
    _enqueueLifecycleOperation(operation) {
        const queuedOperation = this._lifecycleQueue.then(operation);
        this._lifecycleQueue = queuedOperation.catch(() => undefined);
        return queuedOperation;
    }

    /**
     * @returns {Promise<import("../core-capabilities/VideoStreamCapability").StreamURLs>}
     */
    async getStreamURLs() {
        const host = this._getHostAddress();
        const port = this.streamConfig.go2rtcApiPort;

        return {
            rtsp: `rtsp://${host}:8554/vacuum`,
            webrtc: `http://${host}:${port}/api/webrtc?src=vacuum`,
            hls: `http://${host}:${port}/api/stream.m3u8?src=vacuum`,
            go2rtcApi: `http://${host}:${port}/api/`,
        };
    }

    /**
     * @private
     * @returns {boolean}
     */
    _cameraCtlAvailable() {
        return fs.existsSync(this.streamConfig.cameraCtlPath);
    }

    /**
     * Runs camera_ctl.sh. It rejects with the script's reason, for example when
     * the camera is switched off or the camera login is misconfigured.
     *
     * @private
     * @param {"start"|"stop"} action
     * @returns {Promise<void>}
     */
    _runCameraCtl(action) {
        return new Promise((resolve, reject) => {
            execFile(this.streamConfig.cameraCtlPath, [action], {
                env: this._scriptEnv(),
                // Covers camera_ctl.sh waiting up to CAMERA_WAKE_TIMEOUT_SECONDS for video_monitor
                timeout: 30000,
            }, (error, stdout, stderr) => {
                if (error) {
                    const detail = String(stderr).trim() || error.message;

                    reject(new Error(`Video stream ${action} failed: ${detail}`));
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * The native scripts set the preload hook and credential lookup themselves,
     * so inherited values are removed.
     *
     * @private
     * @returns {Object<string, string>}
     */
    _scriptEnv() {
        const env = Object.assign({}, process.env);

        delete env.LD_PRELOAD;
        delete env.CREDENTIALS_DIRECTORY;
        delete env.GO2RTC_USERNAME;
        delete env.GO2RTC_PASSWORD;

        return env;
    }

    /**
     * Get PID of a process by name
     * @private
     * @param {string} processName
     * @returns {number|null}
     */
    _getPidOf(processName) {
        try {
            const result = execSync(`pidof ${processName} 2>/dev/null`, {encoding: "utf-8"}).trim();
            if (result) {
                return parseInt(result.split(" ")[0], 10);
            }
        } catch (e) {
            // Process not found
        }
        return null;
    }

    /**
     * Kill all instances of a process by name
     * @private
     * @param {string} processName
     */
    _killProcess(processName) {
        try {
            execSync(`killall ${processName} 2>/dev/null`);
        } catch (e) {
            // Process might not exist, that's fine
        }
    }

    /**
     * Get the host address for stream URLs
     * @private
     * @returns {string}
     */
    _getHostAddress() {
        const addresses = Object.values(os.networkInterfaces())
            .flat()
            .filter(address => address && address.family === "IPv4" && !address.internal);
        const privateAddress = addresses.find(address => {
            return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address);
        });
        if (privateAddress) {
            return privateAddress.address;
        }
        if (addresses.length > 0) {
            return addresses[0].address;
        }

        try {
            const result = execSync("hostname -I 2>/dev/null || hostname -i 2>/dev/null", {encoding: "utf-8"}).trim();
            const ip = result.split(" ")[0];
            if (ip) {
                return ip;
            }
        } catch (e) {
            // fallback
        }
        return "localhost";
    }

    /**
     * @private
     * @param {number} ms
     * @returns {Promise<void>}
     */
    _sleep(ms) {
        return new Promise(resolve => {
            setTimeout(resolve, ms);
        });
    }
}

module.exports = DreameVideoStreamCapability;

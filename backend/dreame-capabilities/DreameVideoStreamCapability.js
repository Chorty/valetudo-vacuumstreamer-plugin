const fs = require("fs");
const Logger = require("../../../backend/lib/Logger");
const os = require("os");
const VideoStreamCapability = require("../core-capabilities/VideoStreamCapability");
const {execSync, spawn} = require("child_process");

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
     */
    constructor(options) {
        super(options);

        const defaults = {
            vacuumstreamerPath: "/data/vacuumstreamer/vacuumstreamer.so",
            go2rtcPath: "/data/vacuumstreamer/go2rtc",
            go2rtcConfigPath: "/data/vacuumstreamer/go2rtc.yaml",
            videoMonitorPath: "/usr/bin/video_monitor",
            udpPort: 6969,
            go2rtcApiPort: 1984,
            libcPath: "/data/vacuumstreamer/libc.so.6",
        };

        this.streamConfig = Object.assign({}, defaults, options.streamConfig || {});

        // Track child processes
        this._videoMonitorProc = null;
        this._go2rtcProc = null;
        // Status cache to avoid repeated pidof shell spawns on rapid polls
        this._statusCache = null;
        this._statusCacheTs = 0;
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

        this._statusCache = {
            active: videoMonitorPid !== null && go2rtcPid !== null,
            pid: videoMonitorPid,
            go2rtcPid: go2rtcPid,
        };
        this._statusCacheTs = now;

        return this._statusCache;
    }

    /**
     * @returns {Promise<void>}
     */
    async startStream() {
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
                this._go2rtcProc = spawn(this.streamConfig.go2rtcPath, [
                    "-config", this.streamConfig.go2rtcConfigPath
                ], {
                    detached: true,
                    stdio: "ignore",
                    env: Object.assign({}, process.env),
                });
                this._go2rtcProc.unref();

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

            this._videoMonitorProc = spawn(this.streamConfig.videoMonitorPath, [], {
                detached: true,
                stdio: "ignore",
                env: env,
            });
            this._videoMonitorProc.unref();

            Logger.info("Video stream pipeline started successfully");
        } catch (e) {
            Logger.error("Failed to start video_monitor", e);
            throw e;
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async stopStream() {
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

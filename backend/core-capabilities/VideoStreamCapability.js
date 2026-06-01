const Capability = require("../../../backend/lib/core/capabilities/Capability");
const NotImplementedError = require("../../../backend/lib/core/NotImplementedError");

/**
 * Capability for managing the vacuum's video/camera stream.
 * Handles starting/stopping the video pipeline (LD_PRELOAD + go2rtc),
 * retrieving stream URLs, and toggling video quality (high/low resolution).
 *
 * @template {import("../../../backend/lib/core/ValetudoRobot")} T
 * @extends Capability<T>
 */
class VideoStreamCapability extends Capability {
    /**
     * Get the current stream status
     *
     * @abstract
     * @returns {Promise<VideoStreamStatus>}
     */
    async getStreamStatus() {
        throw new NotImplementedError();
    }

    /**
     * Start the video stream pipeline
     *
     * @abstract
     * @returns {Promise<void>}
     */
    async startStream() {
        throw new NotImplementedError();
    }

    /**
     * Stop the video stream pipeline
     *
     * @abstract
     * @returns {Promise<void>}
     */
    async stopStream() {
        throw new NotImplementedError();
    }

    /**
     * Get available stream URLs (RTSP, WebRTC, etc.)
     *
     * @abstract
     * @returns {Promise<StreamURLs>}
     */
    async getStreamURLs() {
        throw new NotImplementedError();
    }

    /**
     * Set video quality (high or low resolution)
     *
     * @abstract
     * @param {string} quality - "high" or "low"
     * @returns {Promise<void>}
     */
    async setVideoQuality(quality) {
        throw new NotImplementedError();
    }

    /**
     * Get current video quality setting
     *
     * @abstract
     * @returns {Promise<string>}
     */
    async getVideoQuality() {
        throw new NotImplementedError();
    }

    getType() {
        return VideoStreamCapability.TYPE;
    }
}

/**
 * @typedef {object} VideoStreamStatus
 * @property {boolean} active - Whether the stream is currently running
 * @property {string} [quality] - Current quality setting ("high" or "low")
 * @property {number} [pid] - PID of the video_monitor process if running
 * @property {number} [go2rtcPid] - PID of go2rtc if running
 */

/**
 * @typedef {object} StreamURLs
 * @property {string} [rtsp] - RTSP stream URL
 * @property {string} [webrtc] - WebRTC stream URL
 * @property {string} [hls] - HLS stream URL
 * @property {string} [go2rtcApi] - go2rtc API base URL
 */

VideoStreamCapability.TYPE = "VideoStreamCapability";

module.exports = VideoStreamCapability;

# valetudo-vacuumstreamer-plugin
VacuumStreamer plugin capabilities for Valetudo (Dreame L10S Pro Ultra Heat) — video streaming, TTS, floor management

## Home Assistant and MQTT

When both MQTT and Home Assistant autodiscovery are enabled in Valetudo, this plugin adds the following entities to the robot device:

- A `notify` entity that speaks its message through the robot speaker
- A diagnostic binary sensor reporting whether speech or audio is playing
- A button that stops current speech or audio playback
- A switch that starts and stops the video streaming pipeline
- Disabled-by-default diagnostic sensors containing the RTSP and WebRTC stream URLs

The live camera stream itself remains on go2rtc/RTSP rather than being transported over MQTT.

Video quality selection is intentionally not exposed. The retired selector never changed capture resolution, recorder settings, bitrate, or go2rtc output; stream start, stop, status, and URL behavior remain supported.

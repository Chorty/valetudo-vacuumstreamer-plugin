# valetudo-vacuumstreamer-plugin
VacuumStreamer plugin capabilities for Valetudo (Dreame L10S Pro Ultra Heat) — video streaming, TTS, floor management

## Runtime Switches

At Valetudo startup the plugin reads `/data/vacuumstreamer/vacuumstreamer.conf`, the same file the native VacuumStreamer boot scripts use. A capability that is switched off is not registered, so its REST routes, MQTT topics and Home Assistant entities are absent. Restart Valetudo after changing a switch.

| Switch | Capability |
|---|---|
| `CAMERA` | `VideoStreamCapability` |
| `TTS` | `TextToSpeechCapability` |
| `MAP_MANAGEMENT` | `MapManagementCapability` |

A missing file, empty value or invalid value keeps the capability on. Invalid values are logged as warnings. See the native VacuumStreamer README for the file format, `CAMERA_LOGIN` and `HTTP_BRIDGE`.

Video start runs `go2rtc_launch.sh --check` and `video_monitor_launch.sh --check` before touching any running process. When the camera is switched off or the camera login is misconfigured, the start is refused with the script's reason. Installs without the launch scripts fall back to starting the binaries directly, without switch or login checks.

## Home Assistant and MQTT

When both MQTT and Home Assistant autodiscovery are enabled in Valetudo, this plugin adds the following entities to the robot device:

- A `notify` entity that speaks its message through the robot speaker
- A diagnostic binary sensor reporting whether speech or audio is playing
- A button that stops current speech or audio playback
- A switch that starts and stops the video streaming pipeline
- Disabled-by-default diagnostic sensors containing the RTSP and WebRTC stream URLs

The live camera stream itself remains on go2rtc/RTSP rather than being transported over MQTT.

Speech and local audio playback are single-flight operations. If audio is already active, the HTTP API responds with
`409` and overlapping MQTT commands are rejected. TTS downloads use a 10-second timeout and can be cancelled with the
existing stop action. Video start and stop commands are serialized so that rapid commands are applied in order.

Video quality selection is intentionally not exposed. The retired selector never changed capture resolution, recorder settings, bitrate, or go2rtc output; stream start, stop, status, and URL behavior remain supported.

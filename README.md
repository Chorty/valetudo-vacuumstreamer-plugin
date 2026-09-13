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

Video start and stop go through the native `camera_ctl.sh`, which applies the switches and camera login and captures on demand. A refused start reports the script's reason. Stop pauses the camera until the next start or robot reboot, even if a viewer keeps retrying.

With `camera_ctl.sh`, the stream status reports:

- `active` when the stream can be watched: go2rtc is running and the camera is not paused
- `capturing` while `video_monitor` runs; in `on_demand` mode this stays false until someone watches
- `paused` and `mode`

Installs without `camera_ctl.sh` start and stop the binaries directly, without switch or login checks, and report `active` only while both processes run.

## Home Assistant and MQTT

When both MQTT and Home Assistant autodiscovery are enabled in Valetudo, this plugin adds the following entities to the robot device:

- A `notify` entity that speaks its message through the robot speaker
- A diagnostic binary sensor reporting whether speech or audio is playing
- A button that stops current speech or audio playback
- A switch that resumes or pauses the camera; with on-demand capture it stays on while the camera waits for a viewer
- Disabled-by-default diagnostic sensors containing the RTSP and WebRTC stream URLs

The live camera stream itself remains on go2rtc/RTSP rather than being transported over MQTT.

Speech and local audio playback are single-flight operations. If audio is already active, the HTTP API responds with
`409` and overlapping MQTT commands are rejected. TTS downloads use a 10-second timeout and can be cancelled with the
existing stop action. Video start and stop commands are serialized so that rapid commands are applied in order.

Video quality selection is intentionally not exposed. The retired selector never changed capture resolution, recorder settings, bitrate, or go2rtc output; stream start, stop, status, and URL behavior remain supported.

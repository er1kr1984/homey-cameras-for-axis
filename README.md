# Cameras for AXIS (Homey app)

A Homey Pro app that talks **directly to Axis cameras** over VAPIX, Axis's open device API. No
recording server is needed. (For AXIS Camera Station Pro, see the separate app
[Homey-AXIS-Camera-Station-Pro](https://github.com/er1kr1984/Homey-AXIS-Camera-Station-Pro).)

Status: version 0.1.0, built from the VAPIX documentation and tested against a fake camera
(`test/fake-camera.js`). Not yet tested on real cameras.

## What it does

| Feature | VAPIX API used |
|---|---|
| Find cameras: Homey's mDNS discovery (`_axis-video._tcp`) plus a scan of Homey's network | Basic device information (anonymous) |
| Log in: Digest (HTTP, RTSP) or Basic (HTTPS); the camera's self-signed certificate is pinned when it is added | Authentication |
| Learn what the camera supports | API discovery, `param.cgi` Properties, GetEventInstances |
| Camera picture, and pictures for flows | `jpg/image.cgi` |
| Live video in the Homey app: RTSP H.264 relayed to WebRTC without re-encoding | RTSP `axis-media/media.amp` |
| Motion alarm, Object Analytics, tampering, day/night, inputs, audio | Event streaming over WebSocket |
| Flow actions: PTZ preset and home, IR/white light, virtual inputs, outputs | `ptz.cgi`, `lightcontrol.cgi`, `virtualinput`, `io/port.cgi` |

### Live video

The app opens one RTSP stream per camera (`videocodec=h264`, RTP over TCP) and forwards its H.264
packets to every viewer over WebRTC, using the same relay as the Camera Station app. Quality levels
pick a resolution the camera supports: Low up to 640 pixels wide, Medium up to 1280, High up to
1920. Automatic starts at Medium and steps down when Homey's CPU gets busy. Keyframes for new viewers
come from a cache, and from `SET_PARAMETER Renew-Stream`. When the camera announces SPS/PPS only in the SDP,
they are inserted before each keyframe. B-frames are dropped when a camera sends them.

### Events

Each camera lists its events (GetEventInstances). The app subscribes to the ones it uses with one
topic filter over `wss://<camera>/vapix/ws-data-stream`, using a `wssession.cgi` token. The motion
alarm follows VMD profiles or ONVIF MotionAlarm, plus Object Analytics scenarios unless that is
switched off. The stream reconnects by itself.

## Camera account

Create a separate user on each camera for Homey (Settings > System > Users):
- **Viewer** is enough for pictures, live video, events and PTZ.
- **Operator** is needed for the light and for outputs.

## Development

```
npm install
npm test                     # unit tests + fake camera + end-to-end relay test
homey app validate --level publish
homey app install            # on your Homey
```

## Not yet

Speakers, door stations as doorbells, door controllers and radar are planned for later versions.

## Disclaimer

This app is not made by, or affiliated with, Axis Communications. AXIS is a trademark of Axis AB,
used here only to describe compatibility.

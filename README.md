# Cameras for AXIS — Homey app

**Live video, motion, people and vehicle analytics, door stations and camera health from your Axis
devices — straight from each device, on your own network.**

This [Homey Pro](https://homey.app) app talks directly to Axis cameras, door stations and recorders
over [VAPIX](https://developer.axis.com/vapix/), Axis's open device API. No cloud, no recording
server and no extra software are needed. (If you use AXIS Camera Station Pro, see the separate app
[Homey-AXIS-Camera-Station-Pro](https://github.com/er1kr1984/Homey-AXIS-Camera-Station-Pro).)

> **Not every Axis device can do everything in this README.** What you get depends on the model,
> its AXIS OS version and the camera apps installed on it. Boxes around objects, people and vehicle
> counting, colours, faces and licence plates need **AXIS Object Analytics** with scene metadata;
> older cameras (for example AXIS OS 9.80) send **no boxes at all**. The app asks every device what
> it supports and only shows that — so two cameras can look quite different in Homey.

---

## Contents

- [What it can do](#what-it-can-do)
- [What your camera needs](#what-your-camera-needs)
- [It adapts to each device](#it-adapts-to-each-device)
- [Getting started](#getting-started)
- [Camera account and rights](#camera-account-and-rights)
- [Device settings](#device-settings)
- [Dashboard widgets](#dashboard-widgets)
- [All flow cards](#all-flow-cards)
- [Capabilities (what a device shows)](#capabilities-what-a-device-shows)
- [Object Analytics and scene metadata in detail](#object-analytics-and-scene-metadata-in-detail)
- [Live video and Homey's CPU](#live-video-and-homeys-cpu)
- [Privacy and security](#privacy-and-security)
- [VAPIX APIs used](#vapix-apis-used)
- [Tested with](#tested-with)
- [Diagnostics](#diagnostics)
- [Development](#development)
- [Disclaimer](#disclaimer)

## What it can do

### See
- **Live video** in the Homey app and on dashboards — the camera's H.264 is relayed to WebRTC
  without re-encoding. Quality adapts to how busy Homey is, and a view left open closes itself after
  a time you choose.
- **Camera picture** on the device, and a fresh picture with every flow that needs one.
- **Boxes around people and vehicles** on the live picture (Analytics widget), labelled with what
  they are and their colours — *only on cameras that send scene metadata; see below*.

### Know what happens
- **Motion** — from AXIS Video Motion Detection, ONVIF motion, Object Analytics and the PIR sensor.
- **People and vehicles** — *needs AXIS Object Analytics*: every person, car, truck, bus, bicycle
  and motorbike is followed while it is in view and counted once, with:
  - colours (vehicle colour, top and trousers separately), bag, hat, licence plate and speed — only
    those details the camera model actually reports;
  - **direction** of travel, with your own names ("Towards the house");
  - **time in view** and a flow when someone stays longer than N minutes;
  - **faces and licence plates** as their own events, with the camera's close-up.
- **Object Analytics scenarios** (*needs AXIS Object Analytics; available scenario types depend
  on its version*) — object in area, line crossing, tailgating, time in area, missing
  hard hat — each as an alarm and a flow; **crossline counting** with totals per type and
  **occupancy in area** with a live count.
- **Insights over time** — today's counts per type, motion per hour, a **heatmap** of where people
  and vehicles go, the usual pattern per hour after a week, **unusual activity** flows and a
  **daily summary** in plain words ("Today: 34 people, 12 cars… Busiest hour 17:00").
- **Sounds** (*cameras with a microphone; classification needs a model with audio analytics*) —
  audio detection, sound classification (glass breaking, screaming, shouting, speech),
  unusual sounds, sound level in dB and the camera's own sound limits.
- **Day/night** mode and the **IR light**.
- **Inputs and outputs** — door contacts wired to the camera, relays, virtual inputs.
- **Door stations** (*Axis door stations/intercoms only*) — call button pressed (doorbell, with a picture), call state, PIN entered,
  card or tag shown, entry allowed/refused, someone at the door.

### Keep an eye on the devices
- **Camera problems** in plain words: tampering (covered, knocked, turned away), memory card
  failures, network loss, too hot or too cold, casing opened, power and PoE problems, fan failure,
  bitrate problems, and **someone blocked after wrong passwords**.
- **Camera temperature** (devices with temperature sensors), **memory card use (%)** (with a card
  inserted), **power use (W)** (only devices that measure their own power draw), and **PoE power per
  port** (Axis recorders with PoE).
- **Recording** and **live view being watched** (also by others, e.g. in AXIS Camera Station).

### Control
- **Privacy mode** — cover the whole picture (live view, recordings, everything) with one switch
  or flow.
- **Text on the picture** ("Away mode", the temperature, …).
- **Play a sound** stored on the camera (needs audio out or a paired network speaker), **siren and
  light** profiles (devices with a siren/strobe).
- **PTZ** presets and home (PTZ or view areas), **IR/white light** (models with light control), **outputs** (gates, relays), **virtual inputs**
  (to start the camera's own action rules).
- **Restart** a camera that hangs; **reset counts** and **test** an Object Analytics alarm.

## What your camera needs

What a device can do depends on its **AXIS OS version**, its **hardware** (scene metadata needs an
ARTPEC-7, ARTPEC-8, ARTPEC-9 or CV25 chip) and the **camera apps** installed on it. The app checks
each device and only shows what it supports.

### By AXIS OS version

| AXIS OS | What the app gets | Source |
|---|---|---|
| **9.80** (LTS) | Events over RTSP (no WebSocket). Scene metadata frames arrive **empty: no boxes and no people/vehicle counting**; you get motion and motion insights instead. Privacy mode through the mask parameters, text through the camera's text field (the dynamic overlay only on some models). IR light, PIR (model), temperature and memory card work. No power measurement. | Seen on M1065-L, M1065-LW, M2026-LE Mk II, M3104-LVE |
| **10.x** | Event streaming over WebSocket arrives during 10.x (release notes mention it around 10.11). From 10.6, cameras with a deep-learning processor can produce object classification metadata. | Axis release notes; not tested |
| **11.x** | Events over WebSocket, `privacymask.cgi`, analytics metadata producer configuration, motion-tracker metadata (plain "moving object" boxes) without Object Analytics, door station call and access events. | Seen on A8207-VE (11.11) |
| **12.x** | All of the above. With AXIS Object Analytics: labelled boxes, people/vehicle counting, vehicle types, clothing and vehicle colours, bag, close-ups (best snapshot), scenario counting and occupancy. Power measurement on models that support it; PoE per port on recorders. | Seen on P3267-LVE (12.6) and S3008 (12.10) |
| **12.8+** | Axis Analytics Data Format 1.0: frames, consolidated object tracks and object snapshots over MQTT and the Device Data Hub. RTSP, which this app uses, carries a subset. | Axis documentation |

Which object classes and attributes a camera reports also differs per model; the camera's datasheet
is the reference.

### By feature

| Feature | The device needs | If it doesn't have it |
|---|---|---|
| Picture, live video | A camera or door station (any AXIS OS) | Recorders, speakers: no picture or live view |
| Motion alarm, motion insights (per hour, usual, unusual, summary) | Motion detection (AXIS Video Motion Detection or ONVIF motion) | — |
| Events | AXIS OS 10+ uses WebSocket; older AXIS OS uses RTSP | Same features, slightly different transport |
| **Labelled boxes** (person, car, …) on the live picture | **AXIS Object Analytics** sending scene metadata (`AnalyticsSceneDescription`) | See next two rows |
| Plain "moving object" boxes (no type) | Scene metadata from the motion tracker (`VideoMotionTracker`), found on some newer AXIS OS versions without Object Analytics | Not counted; only drawn in the Analytics widget |
| No boxes at all | Older AXIS OS (e.g. **9.80**) sends empty scene frames | You still get motion and motion insights |
| People/vehicle counting, direction, time in view, heatmap, Visitors and Traffic per type | AXIS Object Analytics + "Track and count people and vehicles" on | Traffic widget shows motion instead |
| Vehicle type (car/bus/truck), colours, top/trouser colours, bag, hat | Object Analytics on a model and version that reports these attributes | Missing details are simply left empty |
| Faces, licence plates (close-ups) | A camera whose Object Analytics reports `HumanFace` / `LicensePlate` | No face/plate flows |
| Licence plate **number** | A camera or app that reads plates | Plate close-up without the number |
| Speed, position | Radar or radar-video fusion cameras | Speed token is 0 |
| Crossline counting, occupancy, tailgating, time in area, missing hard hat | Object Analytics with those scenarios set up (types depend on its version) | — |
| Motion Guard / Fence Guard / Loitering Guard alarms | That camera app installed and running | — |
| Sound level, sound detection | A microphone (and audio switched on) | — |
| Sound classification (glass break, scream, shout, speech), unusual sound | A model with audio analytics | — |
| Body heat (PIR) | A model with a PIR sensor | — |
| IR / white light control | A model with light control | — |
| Privacy mode | Privacy masks (most cameras) and an **administrator** account | Action refused with a plain message |
| Text on the picture | Any camera (dynamic overlay on newer AXIS OS, the text field on older) | — |
| Play a sound | Audio out or a paired network speaker, and sound clips on the device | — |
| Siren and light | A device with a siren/strobe | — |
| Temperature | Temperature sensors | — |
| Memory card used | A memory card inserted | — |
| Power (W) | AXIS OS that measures the device's own power draw (Power settings API) | — |
| PoE power per port | An Axis recorder with PoE ports | — |
| Door station flows | An Axis door station / intercom | — |
| PTZ presets | PTZ, or digital PTZ / view areas | — |

## It adapts to each device

Each device is asked what it can do — its event list (GetEventInstances), API list (API discovery),
properties, installed camera apps and metadata producers — and **only shows what it really
supports**. A recorder gets no picture, motion or night mode; the body heat sensor only appears on
cameras with a PIR sensor; flow cards only list the devices they work with. This is checked again
at every start and every 30 minutes for newly installed camera apps (for example AXIS Motion
Guard), whose alarms then appear by themselves.

## Getting started

1. Install the app on your Homey Pro.
2. **Devices → + → Cameras for AXIS → Axis camera.**
3. Enter the username and password of an account on the camera (see below). The app then finds
   Axis cameras on Homey's network (mDNS and a network scan of Homey's own subnet) and lists the
   ones that accept this login. If it finds none, for example because your cameras are on a
   separate network or VLAN, it asks for their IP addresses (separated by commas). If it finds
   some but not all, type the missing ones in **Camera addresses** on the login screen. The
   camera's HTTPS certificate is remembered, so nobody can later pretend to be your camera.
4. Optional: in the device settings switch on **Track and count people and vehicles** for cameras
   with AXIS Object Analytics, and give the four directions your own names.
5. Add the [widgets](#dashboard-widgets) to a dashboard and build flows with the
   [cards](#all-flow-cards).

If a camera's address or password changes, use **Repair** on the device (device → ⚙ → Repair).

## Camera account and rights

Create a separate account for Homey on each camera (camera web page → **System → Accounts**, on
older AXIS OS **System → Users**). What each role allows in this app:

| Role | Enough for |
|---|---|
| **Viewer** | Pictures, live video, events, motion, analytics, PTZ presets |
| **Operator** | + IR/white light, outputs, virtual inputs, sound clips, power use and PoE, Object Analytics counts, reset counts and test alarms |
| **Administrator** | + privacy mode, restart, text on the picture on older cameras, switching on the Object Analytics metadata feed |

If an action needs more rights than the account has, the flow says so in plain words.

## Device settings

| Group | Setting | What it does |
|---|---|---|
| Connection | Camera address, Use HTTPS, Video (RTSP) port | Where the camera is. Keep HTTPS on. |
| Video and pictures | Live video quality | Automatic (default: starts Low, goes up to Medium when Homey has room), Low, Medium or High. |
| | Close live view after | 5/15/30/60 minutes or never (default 15). A live view left open keeps Homey busy. |
| | Picture size | Size of the device picture and flow pictures. |
| Motion | Keep motion on for | Seconds the motion alarm stays on after the camera stops seeing motion. |
| | Object Analytics also turns on motion | People/vehicles from Object Analytics count as motion. |
| | Body heat sensor counts as motion | PIR sensor also turns on the motion alarm. |
| People and vehicles | Track and count people and vehicles | Follows and counts every object (AXIS Object Analytics); needed for the people/vehicle flows, insights and widgets. |
| | Direction names (4) | Your own words for left→right, right→left, towards and away from the camera. |
| About this camera | Model, serial number, AXIS OS | Read from the camera. |

## Dashboard widgets

| Widget | Shows |
|---|---|
| **Camera analytics** | Live video (or pictures) with boxes around people and vehicles, motion, counts, sound level, Object Analytics scenarios and counters, latest events. Tap to resume live view after the time limit. |
| **Visitors** | Close-ups of the latest people and vehicles with time, colours, bag, direction and how long they stayed. |
| **Traffic and activity** | People and vehicles (or motion) per hour, day, week or month; the usual line; directions. |
| **Heatmap** | Where people and vehicles walk and drive, over the camera picture; older paths fade. |
| **Overview** | All cameras in one list: motion, people/vehicles in view, motion today, sound level, counters, problems, latest event. |


## All flow cards

Cards are only offered for devices that support them (column "needs"). Generated from
[`driver.flow.compose.json`](drivers/camera/driver.flow.compose.json).

#### When… (32)

| Card | What it does | Tokens / needs |
|---|---|---|
| Motion started | The camera saw motion. Comes with a picture. | Picture · shown for devices with `alarm_motion` |
| Motion stopped |  | shown for devices with `alarm_motion` |
| Object Analytics scenario … triggered | A scenario set up in AXIS Object Analytics on the camera, for example a person in the driveway. | Scenario, Object, Kind of scenario, Picture |
| Camera was tampered with | The camera's view was covered, blurred or changed all at once (for example turned away), or a door station felt a knock or shock. | What happened, Picture · shown for devices with `alarm_tamper` |
| Day/night mode changed |  | Night mode · shown for devices with `axis_night` |
| Input … changed | A digital input on the camera (for example a door contact wired to it) or a virtual input changed. | Input number, Active, Virtual input |
| Sound detected | The camera's audio detection heard a sound above its trigger level. |  |
| Any camera event | For advanced use: every event the app listens to, with its name and details. | Event, Active, Details |
| … was heard | The camera's audio analytics recognised a sound, for example breaking glass. Needs a camera with a microphone and audio analytics switched on. | Sound, Picture |
| Counting scenario … counted | A crossline counting scenario in AXIS Object Analytics counted a person or vehicle crossing its line. The totals are since the counts were last reset (at midnight, or with the 'Reset the counts' card). | Scenario, Total counted, People counted, What crossed, Cars counted, Trucks counted, Buses counted, Bikes counted, Other vehicles counted |
| The camera reported a problem | For example the casing was opened, the SD card failed or the camera got too hot. | Problem |
| A camera problem was solved |  | Problem |
| Someone started or stopped watching live | The camera's live video was opened or closed, in Homey or anywhere else. | Being watched · shown for devices with `axis_watched` |
| A camera schedule started or ended | A schedule set up in the camera (Settings > System > Events > Schedules). | Schedule, Started |
| People or vehicles in view changed | Only when 'Count people and vehicles in view' is switched on in the device settings. | People in view, Vehicles in view, Object types, Colours seen, More people than before, More vehicles than before · shown for devices with `axis_people` |
| A … was detected (colour: …) | Each new person or vehicle the camera's Object Analytics recognises. Needs 'Track and count people and vehicles' on in the device settings. The picture is the camera's own close-up when it sends one. Colour example: pick 'red' to react only to a person in a red top or red trousers, or a red car. Top, trousers, bag, hat, licence plate and speed are filled in when the camera reports them (speed needs a radar camera). | Type, Colours, Picture, Top colour, Trousers colour, Carries a bag, Wears a hat, Licence plate, Speed (km/h) · shown for devices with `axis_people` |
| A … went … (colour: …) | Runs when a person or vehicle leaves the picture, with the way it went. Example: a car going right to left in the picture could be 'leaving the driveway'. Give each direction your own name in the device settings (under 'People and vehicles'). Needs 'Track and count people and vehicles' on in the device settings. | Type, Direction, Seconds in view, Colours, Top colour, Trousers colour, Carries a bag, Wears a hat, Licence plate, Speed (km/h) · shown for devices with `axis_people` |
| A … has been in view for … minutes | Runs once for each person or vehicle that stays in the picture this long. Example: 2 minutes for someone hanging around the gate, 10 minutes for a car parked outside. The camera may stop following objects that stand completely still for a long time. Needs 'Track and count people and vehicles' on in the device settings. | Type, Minutes, Colours, Picture, Top colour, Trousers colour, Carries a bag, Wears a hat, Licence plate, Speed (km/h) · shown for devices with `axis_people` |
| More … than usual | Runs when the camera sees clearly more than usual for this hour, or anything at an hour when there is normally nothing (for example 03:00). It learns what is usual by itself, so it only starts after a week. At most once an hour. Motion works on every camera; people and vehicles need 'Track and count people and vehicles' on in the device settings. | What, Count this hour, Usual for this hour, Hour · shown for devices with `axis_motion_today` |
| Summary of … at … | Runs every day at the time you pick, with a sentence like 'Today: 34 people, 12 cars and 3 bicycles. Busiest hour 17:00 (9).' Use the Summary tag in a notification or have a speaker read it out. Cameras without 'Track and count people and vehicles' give a motion summary instead. | Summary, People, Vehicles, Times motion, Busiest hour · shown for devices with `axis_motion_today` |
| Body heat sensor … | The camera's PIR sensor senses body heat (people, animals) in front of it. It gives far fewer false alarms than motion in the picture: rain, shadows and insects don't set it off. | Sensing someone · shown for devices with `axis_pir` |
| Someone was blocked for wrong logins | The camera blocked an address after too many wrong passwords. Someone may be trying to get into your camera. | Blocked address |
| Sound went … the camera's limit | The limits are set on the camera's own web page (Audio → Sound pressure level). | Above the upper limit · shown for devices with `measure_noise` |
| Someone pressed the call button | A visitor pressed the call button on the door station (it starts calling). The picture is taken at that moment. | Picture · shown for devices with `axis_call` |
| Door station call changed | Calls on the door station: calling, ringing, active (talking) and idle (ended). | Call state, Call in progress · shown for devices with `axis_call` |
| A PIN code was entered | Someone typed a code on the door station's keypad. The digits are only filled in when the door station is set to send them (it hides them by default). | Code · shown for devices with `axis_call` |
| A card or tag was shown | Someone held an RFID card or key fob to the door station's reader. The number is only filled in when the door station is set to send it. | Card number, Card type · shown for devices with `axis_call` |
| The door station … entry | From the door station's own entry list (codes and cards it knows). | Allowed, Code or card · shown for devices with `axis_call` |
| Someone is at the door station | The door station noticed someone in front of it (for example the screen woke up). | shown for devices with `axis_call` |
| A face was seen | The camera's Object Analytics found a face and sent a close-up. Only cameras that report faces; needs 'Track and count people and vehicles' on. | Close-up · shown for devices with `axis_people` |
| A licence plate was seen | The camera's Object Analytics found a licence plate and sent a close-up. The plate number is filled in only on cameras that read plates. Needs 'Track and count people and vehicles' on. | Plate, Country, Close-up · shown for devices with `axis_people` |
| Number in area … changed | An 'Occupancy in area' scenario in AXIS Object Analytics: how many people and vehicles are in its area right now. | Area, In the area now, Change, People, Cars, Trucks, Buses, Bikes, Other vehicles |

#### And… (10)

| Card | What it does | Tokens / needs |
|---|---|---|
| Is in night mode |  | shown for devices with `axis_night` |
| Input … is active |  |  |
| Live view is being watched |  | shown for devices with `axis_watched` |
| Camera has problem |  |  |
| A … is in view | Is the camera seeing one right now? Example: when the doorbell rings AND a person is in view of the garden camera. Needs 'Track and count people and vehicles' on in the device settings. | shown for devices with `axis_people` |
| More than … … in view | Counts the people or vehicles the camera sees right now. Example: more than 3 people in the garden. Needs 'Track and count people and vehicles' on in the device settings. | shown for devices with `axis_people` |
| Body heat sensor senses someone |  | shown for devices with `axis_pir` |
| Privacy mode is on |  | shown for devices with `axis_privacy` |
| A call is in progress |  | shown for devices with `axis_call` |
| More than … in area … |  |  |

#### Then… (17)

| Card | What it does | Tokens / needs |
|---|---|---|
| Take a picture | Gives a picture you can send in a notification. | Picture |
| Move to preset … | For PTZ cameras: move to a preset position saved in the camera. |  |
| Move to the home position | For PTZ cameras. |  |
| Set the light … | The camera's IR or white light. Needs an operator or administrator account. | shown for devices with `axis_ir` |
| … virtual input … for … seconds | Virtual inputs start the camera's own action rules, for example recording to its SD card. Seconds are only used for 'Pulse'. |  |
| … output … for … seconds | A digital output on the camera, for example a relay that opens a gate. Seconds are only used for 'Pulse'. |  |
| Make a traffic summary of … | Gives a sentence like 'Today: 34 people, 12 cars and 3 bicycles. Busiest hour 17:00 (9).' to use in the next cards, for example in a notification. Works in Advanced Flows. Cameras without 'Track and count people and vehicles' give a motion summary instead. | Summary, People, Vehicles, Times motion, Busiest hour · shown for devices with `axis_motion_today` |
| Turn privacy mode … | Covers the whole picture, so live view and recordings show nothing, for example while you're at home. Needs the camera's administrator account. | shown for devices with `axis_privacy` |
| Play sound … at volume … | Plays one of the sounds stored on the camera (camera web page: Audio → Audio clips), through its speaker or a paired network speaker. Volume 0–100; leave empty for the camera's own volume. |  |
| Stop the sound |  |  |
| Start siren and light profile … | For Axis devices with a siren or strobe light. Profiles are made on the device's web page. |  |
| Stop siren and light |  |  |
| Restart the camera | For when a camera hangs. It's gone for about a minute. Needs the camera's administrator account. |  |
| Show … on the picture at … | For example 'Away mode' or the outside temperature. The text stays until you change or remove it. The same card again changes the text. |  |
| Remove the text from the picture |  |  |
| Reset the counts of … | Sets a crossline counting scenario in AXIS Object Analytics back to 0. |  |
| Test alarm of … | Makes the scenario give its alarm for 3 seconds, to try out your flows and the camera's own rules. |  |

## Capabilities (what a device shows)

| Capability | Shown when the device… |
|---|---|
| Motion alarm, Motion today | reports motion (VMD, ONVIF), Object Analytics or a PIR sensor |
| Tamper alarm | reports tampering, shock or global scene change |
| Night mode | reports day/night switching |
| Problem alarm + problem text | always (every device reports its health) |
| IR light | has light control |
| Sound level (dB) | has sound pressure level metrics |
| Recording, Live view being watched | has its own video and reports these |
| Body heat (PIR) | has a PIR sensor |
| Call in progress | is a door station (call state events) |
| Privacy mode (switch) | supports privacy masks |
| Temperature | has temperature sensors |
| Memory card used (%) | has a memory card inserted |
| Power (W) | measures its own power draw (Power settings API) |
| PoE power to devices (+ per port) | is a recorder with PoE ports (kept separate from Power so Homey Energy doesn't count cameras twice) |
| One alarm per Object Analytics / guard scenario | has such scenarios |
| Counted (per crossline counting scenario) | has crossline counting scenarios |
| In the area now (per occupancy scenario) | has occupancy in area scenarios |
| People in view, Vehicles in view, … today | has "Track and count people and vehicles" on |

## Object Analytics and scene metadata in detail

The app reads AXIS Object Analytics in two ways:

**1. Scenario events** (`CameraApplicationPlatform/ObjectAnalytics/Device<n>Scenario<id>`). Alarm
scenarios carry `classTypes`, `scenarioType`, `objectId`; crossline counting carries `total`,
`totalHuman`, `totalCar`, `totalTruck`, `totalBus`, `totalBike`, `totalOtherVehicle`, `reason`,
`resetTime`; occupancy carries `total`, `human`, `car`, `truck`, `bus`, `bike`, `otherVehicle`. At
start the current numbers are read with the AOA API (`getAccumulatedCounts`, `getOccupancy`).

**2. The scene description** (RTSP `analytics=polygon`, ONVIF `tt:Frame`, producer
`AnalyticsSceneDescription`), read about three times a second while tracking is on:

| Metadata | ONVIF element | Used for |
|---|---|---|
| Object class | `tt:Class/tt:Type` (Human, HumanFace, LicensePlate, Bike, Vehicle) | category, counting |
| Vehicle type | `tt:VehicleInfo/tt:Type` (Car, Bus, Truck, Vehicle = other) | car / bus / truck / other vehicle |
| Vehicle colour | `tt:Appearance/tt:Color/tt:ColorCluster` | colour filter, tokens |
| Clothing colours | `tt:HumanBody/bd:Clothing/bd:Tops`, `bd:Bottoms` | top / trousers tokens |
| Bag, hat | `bd:Belonging/bd:Bag`, hat/headwear | tokens, Visitors widget |
| Licence plate | `tt:LicensePlateInfo/tt:PlateNumber`, `tt:CountryCode` | plate flow |
| Speed, position | `tt:Behaviour/tt:Speed`, `tt:GeoLocation` (radar / radar-video fusion) | speed token |
| Close-up | `tt:Image` (best snapshot, base64 JPEG) | flow pictures, Visitors widget |
| Box | `tt:Shape/tt:BoundingBox` | boxes, direction, heatmap |
| Same object, new id | `tt:ObjectTree/tt:Rename`, `tt:Merge`, `tt:Delete` | no double counts |

Colours follow the eight Axis colour classes (beige, black, blue, grey, green, red, white, yellow).
An object is counted once after two confident frames; faces and plates are reported but never
counted as visitors. When counting is switched on and the camera's metadata producer is off, the app
switches it on (`analyticsmetadataconfig.cgi setEnabledProducers`). The parser is tested against
the sample frame the P3267 itself returns (`getSupportedMetadata`,
[`test/fixtures/asd-sample-p3267.xml`](test/fixtures/asd-sample-p3267.xml)).

Cameras without Object Analytics still get **motion insights**: how often and how long there was
motion per hour, the usual pattern, unusual activity and the daily summary.

## Live video and Homey's CPU

Homey stops an app that uses too much CPU for about two minutes. Relaying video is the heaviest thing
this app does, so:

- the camera is asked for a capped bitrate (`videobitratemode=mbr&videomaxbitrate`, falling back
  for older AXIS OS): Low 640 px / 10 fps / 0.5 Mbit/s, Medium 1280 px / 15 fps / 1.2 Mbit/s,
  High 1920 px / 25 fps / 2.5 Mbit/s;
- **Automatic** starts Low and steps up to Medium only when there is room;
- on Homey's CPU warnings every stream steps down at once; near the limit live views are closed so
  the app keeps running;
- a live view closes after the time limit (default 15 min); silent viewers after 8 s;
- the WebRTC library is only loaded when someone watches; cameras start a few seconds apart.

Without live view the app idles at a few percent CPU and about 60 MB of memory.

## Privacy and security

- Everything stays on your network: Homey talks to the devices directly; nothing goes to a cloud.
- HTTPS with the camera's certificate pinned when the device is added (a changed certificate is
  refused, with a Repair to accept a new one); Digest login.
- Passwords are stored only in the Homey device store.
- Privacy mode is drawn by the camera itself, so it applies to every viewer and recording.

## VAPIX APIs used

| Purpose | API |
|---|---|
| Find devices | mDNS `_axis-video._tcp`, Basic device information (`basicdeviceinfo.cgi`) |
| What a device supports | API discovery (`apidiscovery.cgi`), `param.cgi` Properties, GetEventInstances, Application API (`applications/list.cgi`) |
| Pictures | `jpg/image.cgi` |
| Live video | RTSP `axis-media/media.amp` (H.264, RTP over TCP) |
| Events | Event streaming over WebSocket (`ws-data-stream`, `wssession.cgi`); RTSP metadata events on older AXIS OS |
| Object Analytics | Scene description over RTSP; AOA API `/local/objectanalytics/control.cgi`; Analytics metadata producer configuration |
| PTZ, light, I/O | `com/ptz.cgi`, `lightcontrol.cgi`, `io/port.cgi`, `virtualinput/*.cgi` |
| Privacy mode | Overlay API `privacymask.cgi`, or `Image.I0.Overlay.MaskWindows` parameters on older AXIS OS |
| Text on the picture | Dynamic overlay API, or `Image.I0.Text` parameters on older AXIS OS |
| Sounds, siren | Media clip API (`mediaclip.cgi`, `playclip.cgi`), Siren and light (`siren_and_light.cgi`) |
| Restart | Firmware management API (`firmwaremanagement.cgi` reboot), `restart.cgi` |
| Temperature | Temperature control (`temperaturecontrol.cgi`) |
| Memory card | Edge storage (`disks/list.cgi`) |
| Power | Power settings (`power-settings.cgi getPowerStatus`), NVR PoE (`nvr/poe/getportstatuses.cgi`) |
| Door stations | Intercom service and Call service events |

## Tested with

| Device | AXIS OS | Notes |
|---|---|---|
| AXIS P3267-LVE Mic | 12.6 | Object Analytics, scene metadata, sound, power use |
| AXIS A8207-VE door station | 11.11 | PIR, call and access events |
| AXIS M1065-L / M1065-LW | 9.80 | PIR; privacy mode, text and restart tried on the device |
| AXIS M2026-LE Mk II, M3104-LVE | 9.80 | |
| AXIS S3008 recorder | 12.10 | PoE per port, temperature, health |

Features for hardware not listed (sirens, licence plate reading, radar speed, fans) are built from
the VAPIX documentation and tested against documented example answers.

## Diagnostics

App settings → **Diagnostics** keeps a log that also survives a crash. With it switched on, the
app's web API offers `/logs`, `/previous-logs` and `/features` — the last one lists, per device, its
VAPIX APIs, properties, apps, event types (and what the app does with each), metadata producers with
sample frames, and the Object Analytics configuration.

## Development

```
npm install
npm test                             # unit tests, fake camera, end-to-end live video relay
homey app validate --level publish
homey app install                    # install on your Homey (use install, not run)
```

```
app.js                    app: live relay, widgets API, diagnostics
drivers/camera/           device (events, analytics, actions), driver (pairing, flow cards)
lib/vapix.js              VAPIX client (Digest/Basic, certificate pinning, all API calls)
lib/event-stream.js       events over WebSocket;  lib/rtsp-events.js  RTSP events + scene metadata
lib/events-map.js         what each Axis event topic means
lib/tracker.js            people/vehicle tracking, direction, dwell, heatmap, usual/unusual
lib/activity.js           motion insights;  lib/timeline.js  visitor pictures
lib/live-relay.js         RTSP → WebRTC relay, quality and CPU handling
widgets/                  five dashboard widgets
test/                     unit tests, fake camera (documented VAPIX answers), fixtures
```

## Disclaimer

This app is not made by, or affiliated with, Axis Communications. AXIS is a trademark of Axis AB,
used here only to describe compatibility.

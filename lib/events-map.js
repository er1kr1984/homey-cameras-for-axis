'use strict';

// What Axis event topics mean for Homey.
//
// Topics come from GetEventInstances (what the camera can send) and from the event
// stream, written with namespace prefixes, e.g.
//   tns1:VideoSource/MotionAlarm                                   ONVIF motion (any VMD profile)
//   tnsaxis:CameraApplicationPlatform/VMD/Camera1Profile1          AXIS Video Motion Detection 4
//   tnsaxis:CameraApplicationPlatform/ObjectAnalytics/Device1Scenario1   AXIS Object Analytics
//   tns1:VideoSource/tnsaxis:Tampering                             tampering (pulse)
//   tns1:VideoSource/tnsaxis:DayNightVision                        day (1) / night (0)
//   tns1:Device/tnsaxis:IO/Port                                    digital input / output
//   tnsaxis:AudioClassification/GlassBreak                         audio analytics
//   tnsaxis:SoundPressureLevel/Metrics                             sound level (dB)
// Prefixes vary between AXIS OS versions (tnsaxis: / axis:), so matching ignores them.

// Camera health topics: what each means, in the words of locales "problems.*".
const HEALTH = [
  { test: /^Device\/Casing\/Open$/, problem: 'casing' },
  { test: /^Device\/Network\/Lost$/, problem: 'network' },
  { test: /^Device\/Status\/Temperature\/Above$/, problem: 'hot' },
  { test: /^Device\/Status\/Temperature\/Below$/, problem: 'cold' },
  { test: /^Device\/HardwareFailure\/StorageFailure$/, problem: 'storageFailure' },
  { test: /^Storage\/Disruption$/, problem: 'storage' },
  { test: /^Storage\/Alert$/, problem: 'storageAlert' },
  { test: /^Device\/HardwareFailure\/PowerSupplyFailure\//, problem: 'power' },
  { test: /^Device\/RingPowerLimitExceeded$/, problem: 'power' },
  { test: /^VideoSource\/ABR$/, problem: 'bitrate' },
  { test: /^PTZController\/PTZError$/, problem: 'ptz' },
  { test: /^Device\/SystemMessage\/ActionFailed$/, problem: 'actionFailed' },
  { test: /^Device\/HardwareFailure\/FanFailure$/, problem: 'fan' },
  { test: /^Device\/HardwareFailure\/PoEFailure$/, problem: 'poe' },
];

const KINDS = [
  { kind: 'motion', test: /^VideoSource\/MotionAlarm$|^CameraApplicationPlatform\/VMD\/Camera\w+Profile\w+$|^RuleEngine\/MotionRegionDetector\/Motion$|^VideoAnalytics\/MotionDetection$/ },
  { kind: 'analytics', test: /^CameraApplicationPlatform\/(ObjectAnalytics|MotionGuard|FenceGuard|LoiteringGuard|CrossLineDetection)\// },
  // Tampering: the image was covered or blurred, a shock or knock (door stations), or the
  // whole view changed at once (ONVIF global scene change, e.g. the camera was turned).
  { kind: 'tampering', test: /^VideoSource\/Tampering$|^Device\/Tampering\/ShockDetected$|^VideoSource\/GlobalSceneChange\// },
  { kind: 'pir', test: /^Device\/Sensor\/PIR$/ },
  { kind: 'blockedip', test: /^Device\/Network\/BlockedIP$/ },
  { kind: 'soundlimit', test: /^SoundPressureLevel\/(AboveThresholdUpper|BelowThresholdLower)$/ },
  // Door stations (VAPIX Intercom service and Call service).
  { kind: 'call', test: /^Call\/State$|^Device\/Intercom\/CallState$/ },
  { kind: 'pin', test: /^Device\/Intercom\/KeyPin$/ },
  { kind: 'rfid', test: /^Device\/Intercom\/RFID$/ },
  { kind: 'access', test: /^Device\/Intercom\/EL(AccessGranted|AccessDenied|Custom)$/ },
  { kind: 'presence', test: /^Device\/Intercom\/MainState$/ },
  { kind: 'daynight', test: /^VideoSource\/DayNightVision$/ },
  { kind: 'input', test: /^Device\/IO\/(Port|VirtualInput|VirtualPort)$/ },
  { kind: 'audio', test: /^AudioSource\/TriggerLevel$/ },
  { kind: 'audioclass', test: /^AudioClassification\/\w+$|^AdaptiveAudioDetection\/Detected$/ },
  { kind: 'soundlevel', test: /^SoundPressureLevel\/Metrics$/ },
  { kind: 'watched', test: /^VideoSource\/LiveStreamAccessed$/ },
  { kind: 'recording', test: /^Storage\/Recording$/ },
  { kind: 'light', test: /^Device\/Light\/Status$|^LightControl\/LightStatusChanged\/Status$/ },
  { kind: 'schedule', test: /^UserAlarm\/Recurring\/Interval$/ },
  { kind: 'ptz', test: /^PTZController\/PTZPresets\// },
  { kind: 'health', test: { test: (b) => HEALTH.some((h) => h.test.test(b)) } },
];

// 'tns1:VideoSource/tnsaxis:Tampering' -> 'VideoSource/Tampering'
function bare(topic) {
  return String(topic).split('/').map((p) => p.slice(p.indexOf(':') + 1)).join('/');
}

// Internal topics some apps publish for their own use (e.g. Object Analytics overlay
// frames, many per second); never events for Homey.
const IGNORED = /\/xinternal_|\/xinternal$/i;

function classify(topic) {
  const b = bare(topic);
  if (IGNORED.test(b)) return null;
  const hit = KINDS.find((k) => k.test.test(b));
  return hit ? hit.kind : null;
}

// For a health topic: the problem's key (locales problems.<key>), else null.
function problemOf(topic) {
  const b = bare(topic);
  const hit = HEALTH.find((h) => h.test.test(b));
  return hit ? hit.problem : null;
}

const STATE_FIELDS = ['State', 'state', 'active', 'Active', 'triggered', 'motion', 'day', 'ready', 'tampering', 'IsMotion', 'IsInside',
  'disruption', 'recording', 'on_preset', 'accessed', 'lost', 'Open', 'connected', 'Playing', 'Detected', 'sensor_level',
  'abr_error', 'Failed', 'limit_exceeded', 'alert', 'running'];

function truthy(v) {
  return v === true || v === 1 || /^(1|true|yes|on)$/i.test(String(v));
}

// The on/off value an event carries, or null for events without one (pulses).
function stateOf(event) {
  for (const f of STATE_FIELDS) {
    if (event.data && event.data[f] !== undefined) return truthy(event.data[f]);
  }
  return null;
}

// A stable key per thing that can be on or off (topic + its source, e.g. the port).
function sourceKey(event) {
  const src = Object.keys(event.source || {}).sort().map((k) => `${k}=${event.source[k]}`).join(',');
  return `${bare(event.topic)}${src ? `|${src}` : ''}`;
}

// The ONVIF MotionAlarm repeats what VMD already says; when a camera has VMD profile
// events, motion uses those (they carry the profile), else MotionAlarm.
function motionTopics(instances) {
  const motion = instances.filter((i) => classify(i.topic) === 'motion');
  const vmd = motion.filter((i) => /VMD\//.test(bare(i.topic)) && !/ANY$/.test(i.topic));
  return vmd.length ? vmd : motion.filter((i) => !/ANY$/.test(i.topic));
}

// 'Object Analytics: Person in garden' -> 'Person in garden'
function cleanName(name) {
  return String(name || '').replace(/^(Object Analytics|VMD 4|Motion Guard|Fence Guard|Loitering Guard):\s*/i, '').trim();
}

// Object Analytics / guard scenarios: [{ topic, name, counting, stateful, id }].
// The analytics scenarios a camera has, from the data their events carry (AXIS Object
// Analytics "counting data"):
//   counting   crossline counting: totals since the last reset (total, totalHuman, ...)
//   occupancy  occupancy in area: how many are in the area now (total, human, car, ...)
//   neither    an alarm scenario (motion/object in area, line crossing, tailgating,
//              time in area, ...) that is on or off.
// id is safe for use in a capability id.
function analyticsScenarios(instances) {
  return instances
    .filter((i) => classify(i.topic) === 'analytics' && !/ANY$/.test(i.topic))
    .map((i) => {
      const topic = bare(i.topic);
      const data = i.data || [];
      const counting = data.some((d) => /^total./.test(d) || d === 'resetTime' || d === 'reason');
      const occupancy = !counting && data.includes('total') && data.some((d) => ['human', 'car', 'truck', 'bus', 'bike', 'otherVehicle'].includes(d));
      return {
        topic,
        name: cleanName(i.name) || scenarioName(topic),
        counting: counting || (data.includes('total') && !occupancy),
        occupancy,
        stateful: Boolean(i.stateful),
        id: scenarioId(topic),
        // Object Analytics scenario number (Device1Scenario<n>), for its API.
        aoaId: (/ObjectAnalytics\/Device\d+Scenario(-?\d+)$/.exec(topic) || [])[1] || null,
      };
    });
}

// Per-class numbers in an Object Analytics counting/occupancy event:
// { total, human, car, truck, bus, bike, otherVehicle, reason }
const COUNT_CLASSES = ['human', 'car', 'truck', 'bus', 'bike', 'otherVehicle'];
function countsOf(details, occupancy) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const out = { total: n(details.total), reason: String(details.reason || '') };
  for (const c of COUNT_CLASSES) {
    out[c] = n(occupancy ? details[c] : details[`total${c[0].toUpperCase()}${c.slice(1)}`]);
  }
  return out;
}

// 'CameraApplicationPlatform/ObjectAnalytics/Device1Scenario-1119631251' -> 'oa_d1s_m1119631251'
function scenarioId(topic) {
  const parts = bare(topic).split('/');
  const app = { ObjectAnalytics: 'oa', MotionGuard: 'mg', FenceGuard: 'fg', LoiteringGuard: 'lg', CrossLineDetection: 'cl' }[parts[1]] || 'an';
  const last = parts[parts.length - 1].replace(/^Device(\d+)Scenario/, 'd$1s_').replace(/-/g, 'm').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `${app}_${last}`;
}

function scenarioName(topic) {
  const b = bare(topic);
  const m = /ObjectAnalytics\/Device(\d+)Scenario(-?\d+)/.exec(b);
  if (m) return `Object Analytics scenario ${m[2]}`;
  return b.split('/').slice(1).join(' ');
}

// The topics the app subscribes to, built only from topics this camera actually has
// (an unknown topic could make the camera refuse the subscription).
function usedTopics(instances) {
  return [...new Set(instances.filter((i) => classify(i.topic)).map((i) => i.topic))];
}

function topicFilter(instances) {
  const topics = usedTopics(instances);
  return topics.length ? topics.join('|') : null;
}

// AudioClassification/GlassBreak -> 'glassbreak'; AdaptiveAudioDetection/Detected -> 'unusual'
function soundOf(topic) {
  const b = bare(topic);
  if (/^AdaptiveAudioDetection\//.test(b)) return 'unusual';
  return b.split('/').pop().toLowerCase();
}

module.exports = {
  classify, stateOf, sourceKey, bare, motionTopics, analyticsScenarios, countsOf, COUNT_CLASSES, topicFilter, usedTopics, truthy,
  problemOf, cleanName, scenarioId, soundOf,
};

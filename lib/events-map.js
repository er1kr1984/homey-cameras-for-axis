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
//   tns1:Device/tnsaxis:IO/VirtualInput                            virtual input
//   tns1:AudioSource/tnsaxis:TriggerLevel                          audio detection
// Prefixes vary between AXIS OS versions (tnsaxis: / axis:), so matching ignores them.

const KINDS = [
  { kind: 'motion', test: /^VideoSource\/MotionAlarm$|^CameraApplicationPlatform\/VMD\/Camera\w+Profile\w+$|^RuleEngine\/MotionRegionDetector\/Motion$|^VideoAnalytics\/MotionDetection$/ },
  { kind: 'analytics', test: /^CameraApplicationPlatform\/(ObjectAnalytics|MotionGuard|FenceGuard|LoiteringGuard|CrossLineDetection)\// },
  { kind: 'tampering', test: /^VideoSource\/Tampering$/ },
  { kind: 'daynight', test: /^VideoSource\/DayNightVision$/ },
  { kind: 'input', test: /^Device\/IO\/(Port|VirtualInput|VirtualPort)$/ },
  { kind: 'audio', test: /^AudioSource\/TriggerLevel$/ },
  { kind: 'ptz', test: /^PTZController\/PTZPresets\// },
  { kind: 'storage', test: /^Storage\/(Disruption|Recording)$/ },
];

// 'tns1:VideoSource/tnsaxis:Tampering' -> 'VideoSource/Tampering'
function bare(topic) {
  return String(topic).split('/').map((p) => p.slice(p.indexOf(':') + 1)).join('/');
}

function classify(topic) {
  const b = bare(topic);
  const hit = KINDS.find((k) => k.test.test(b));
  return hit ? hit.kind : null;
}

const STATE_FIELDS = ['State', 'state', 'active', 'Active', 'triggered', 'motion', 'day', 'ready', 'tampering', 'IsMotion', 'IsInside'];

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

// Object Analytics / guard scenarios, for the flow card's list: [{ topic, name }].
function analyticsScenarios(instances) {
  return instances
    .filter((i) => classify(i.topic) === 'analytics' && !/ANY$/.test(i.topic))
    .map((i) => ({ topic: bare(i.topic), name: i.name || scenarioName(i.topic) }));
}

function scenarioName(topic) {
  const b = bare(topic);
  const m = /ObjectAnalytics\/Device(\d+)Scenario(\d+)/.exec(b);
  if (m) return `Object Analytics scenario ${m[2]}`;
  return b.split('/').slice(1).join(' ');
}

// One topic filter for events:configure covering what the app uses, built only from
// topics this camera actually has (an unknown topic could make the camera refuse it).
function topicFilter(instances) {
  const wanted = instances.filter((i) => classify(i.topic));
  const topics = [...new Set(wanted.map((i) => i.topic))];
  return topics.length ? topics.join('|') : null;
}

module.exports = {
  classify, stateOf, sourceKey, bare, motionTopics, analyticsScenarios, topicFilter, truthy,
};

/* The 48 New Hampshire four-thousand footers.
   Elevations (ft): Wikipedia's "Four-thousand footers" list. Sources differ by up to about 20 ft, and a loaded DEM overrides them.
   Coordinates: per-peak pages on nh48.info. Treat them as accurate to a few hundred metres. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NH48 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var RAW = [
    ['mount-washington', 'Mount Washington', 6288, 44.2705, -71.30325],
    ['mount-adams', 'Mount Adams', 5774, 44.32056, -71.29139],
    ['mount-jefferson', 'Mount Jefferson', 5712, 44.30417, -71.31667],
    ['mount-monroe', 'Mount Monroe', 5384, 44.25537, -71.32154],
    ['mount-madison', 'Mount Madison', 5367, 44.32833, -71.27667],
    ['mount-lafayette', 'Mount Lafayette', 5249, 44.16028, -71.64417],
    ['mount-lincoln', 'Mount Lincoln', 5089, 44.14833, -71.64444],
    ['south-twin-mountain', 'South Twin Mountain', 4902, 44.18756, -71.5548],
    ['carter-dome', 'Carter Dome', 4832, 44.26734, -71.17926],
    ['mount-moosilauke', 'Mount Moosilauke', 4802, 44.02472, -71.8303],
    ['mount-eisenhower', 'Mount Eisenhower', 4780, 44.24073, -71.35018],
    ['north-twin-mountain', 'North Twin Mountain', 4761, 44.20256, -71.55786],
    ['mount-carrigain', 'Mount Carrigain', 4700, 44.09365, -71.4467],
    ['mount-bond', 'Mount Bond', 4698, 44.15306, -71.53],
    ['middle-carter-mountain', 'Middle Carter Mountain', 4610, 44.30311, -71.16781],
    ['west-bond', 'West Bond', 4540, 44.15473, -71.54351],
    ['mount-garfield', 'Mount Garfield', 4500, 44.18726, -71.61068],
    ['mount-liberty', 'Mount Liberty', 4459, 44.11589, -71.64203],
    ['south-carter-mountain', 'South Carter Mountain', 4430, 44.28978, -71.17664],
    ['wildcat-mountain-a', 'Wildcat Mountain (A Peak)', 4422, 44.25902, -71.20166],
    ['mount-hancock', 'Mount Hancock (North Peak)', 4420, 44.08368, -71.49369],
    ['south-kinsman-mountain', 'South Kinsman Mountain', 4358, 44.123, -71.73667],
    ['mount-field', 'Mount Field', 4340, 44.19614, -71.4331],
    ['mount-osceola', 'Mount Osceola', 4340, 44.00161, -71.53561],
    ['mount-flume', 'Mount Flume', 4328, 44.10889, -71.62778],
    ['mount-hancock-south', 'South Hancock', 4319, 44.07333, -71.48722],
    ['mount-pierce', 'Mount Pierce', 4310, 44.22694, -71.36528],
    ['north-kinsman-mountain', 'North Kinsman Mountain', 4293, 44.123, -71.73833],
    ['mount-willey', 'Mount Willey', 4285, 44.18353, -71.42074],
    ['bondcliff', 'Bondcliff', 4265, 44.14065, -71.54062],
    ['zealand-mountain', 'Zealand Mountain', 4260, 44.17967, -71.52133],
    ['north-tripyramid', 'North Tripyramid', 4180, 43.97314, -71.44288],
    ['mount-cabot', 'Mount Cabot', 4170, 44.506, -71.41433],
    ['mount-osceola-east-peak', 'East Osceola', 4156, 44.00611, -71.52028],
    ['middle-tripyramid', 'Middle Tripyramid', 4140, 43.96471, -71.43995],
    ['cannon-mountain', 'Cannon Mountain', 4100, 44.15661, -71.6988],
    ['wildcat-mountain-d', 'Wildcat D Peak', 4070, 44.24945, -71.22355],
    ['mount-hale', 'Mount Hale', 4054, 44.22172, -71.51202],
    ['mount-jackson', 'Mount Jackson', 4052, 44.20333, -71.37583],
    ['mount-tom', 'Mount Tom', 4051, 44.21052, -71.44606],
    ['mount-moriah', 'Mount Moriah', 4049, 44.34064, -71.13185],
    ['mount-passaconaway', 'Mount Passaconaway', 4043, 43.95417, -71.38111],
    ['owls-head', "Owl's Head", 4025, 44.14449, -71.60493],
    ['galehead-mountain', 'Galehead Mountain', 4024, 44.18528, -71.57361],
    ['mount-whiteface', 'Mount Whiteface', 4020, 43.93395, -71.40591],
    ['mount-waumbek', 'Mount Waumbek', 4006, 44.43283, -71.41702],
    ['mount-isolation', 'Mount Isolation', 4004, 44.21479, -71.30924],
    ['mount-tecumseh', 'Mount Tecumseh', 4003, 43.96667, -71.55667]
  ];
  return RAW.map(function (r, i) {
    return { id: r[0], name: r[1], ft: r[2], m: r[2] * 0.3048, lat: r[3], lon: r[4], rank: i + 1 };
  });
});

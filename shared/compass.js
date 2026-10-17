// compass.js — one compass heading from iOS and Android.
//
// iOS Safari: needs DeviceOrientationEvent.requestPermission() from a tap,
//   then gives `webkitCompassHeading` (0 = north, clockwise) directly.
// Android Chrome: `deviceorientationabsolute` gives alpha/beta/gamma relative
//   to true north. alpha runs anticlockwise, so heading = 360 − alpha.
//
// Two headings matter, because the phone may be held flat OR be upright in a
// pocket:
//   topHeading    — where the top edge of the phone points (good when flat)
//   cameraHeading — where the back of the phone points (good when upright,
//                   e.g. in a pocket, where it follows the hips)
// `heading` picks whichever is meaningful for the current tilt.

// Must be called synchronously inside a tap handler on iOS.
export function requestCompassPermission() {
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    return DOE.requestPermission().catch(() => 'denied');
  }
  return Promise.resolve('granted');
}

const DEG = Math.PI / 180;

// Direction the back of the device points, projected onto the ground.
// From the W3C Device Orientation spec's worked example.
function cameraHeadingFrom(alpha, beta, gamma) {
  const x = beta * DEG, y = gamma * DEG, z = alpha * DEG;
  const cX = Math.cos(x), cY = Math.cos(y), cZ = Math.cos(z);
  const sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
  const Vx = -cZ * sY - sZ * sX * cY;
  const Vy = -sZ * sY + cZ * sX * cY;
  let h = Math.atan2(Vx, Vy) / DEG;
  return (h + 360) % 360;
}

export function startCompass(onReading) {
  let source = 'none';
  let gotAbsolute = false;

  function handle(e, kind) {
    const { alpha, beta, gamma } = e;
    const reading = { t: performance.now(), raw: { alpha, beta, gamma }, accuracy: null };

    if (typeof e.webkitCompassHeading === 'number') {
      // iOS
      source = 'ios-webkitCompassHeading';
      reading.heading = e.webkitCompassHeading;
      reading.topHeading = e.webkitCompassHeading;
      reading.cameraHeading = null;
      reading.accuracy = e.webkitCompassAccuracy; // degrees, −1 = unreliable
    } else if (e.absolute && alpha !== null) {
      // Android (absolute)
      source = kind;
      reading.topHeading = (360 - alpha) % 360;
      reading.cameraHeading = cameraHeadingFrom(alpha, beta || 0, gamma || 0);
      // Flat-ish phone → top edge; upright phone → back of phone.
      const flat = Math.abs(beta || 0) < 45 && Math.abs(gamma || 0) < 45;
      reading.heading = flat ? reading.topHeading : reading.cameraHeading;
      reading.mode = flat ? 'flat' : 'upright';
    } else {
      return; // relative-only orientation: not usable as a compass
    }
    reading.source = source;
    onReading(reading);
  }

  const onAbs = (e) => { gotAbsolute = true; handle(e, 'android-absolute'); };
  const onRel = (e) => { if (!gotAbsolute) handle(e, 'deviceorientation'); };

  window.addEventListener('deviceorientationabsolute', onAbs);
  window.addEventListener('deviceorientation', onRel);

  return {
    get source() { return source; },
    stop() {
      window.removeEventListener('deviceorientationabsolute', onAbs);
      window.removeEventListener('deviceorientation', onRel);
    },
  };
}

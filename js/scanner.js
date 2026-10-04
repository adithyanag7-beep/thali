// Barcode reading with the bundled ZXing decoder (vendor/barcode-detector.js +
// vendor/zxing_reader.wasm), so it works the same on every iPhone and offline.

import { CONFIG } from './config.js';
import { canvasFromFile } from './image.js';

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
let detector = null;

function getDetector() {
  if (detector) return detector;
  const api = window.BarcodeDetectionAPI;
  if (!api) throw new Error('The barcode reader didn’t load. Close and reopen the app.');
  api.prepareZXingModule({
    overrides: {
      locateFile: (path, prefix) => (path.endsWith('.wasm') ? new URL('vendor/' + path, document.baseURI).href : prefix + path),
    },
  });
  detector = new api.BarcodeDetector({ formats: FORMATS });
  return detector;
}

export function cameraSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

// Explains a camera error in plain words.
export function cameraErrorMessage(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access is turned off for this app. Close the app completely and open it again, then tap Allow when asked. If it doesn’t ask: open the iPhone Settings app, go to Safari (or Apps › Safari), tap Camera and choose Ask or Allow.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'The camera is busy, maybe in another app. Close other apps using the camera and try again.';
  return 'The live camera didn’t start on this phone.';
}

export class LiveScanner {
  constructor(video, onCode) {
    this.video = video;
    this.onCode = onCode;
    this.stream = null;
    this.running = false;
    this.canvas = document.createElement('canvas');
    this.busy = false;
  }

  async start() {
    const d = getDetector();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    if (!this.video.isConnected) { this.stop(); return; }
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    this.tryZoom();
    this.running = true;
    this.detector = d;
    this.loop();
  }

  // Newer iPhones with several lenses can't focus very close; a little zoom
  // lets people hold the phone further back. Ignored where unsupported.
  tryZoom() {
    try {
      const track = this.stream.getVideoTracks()[0];
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.zoom && caps.zoom.max >= 1.5) {
        track.applyConstraints({ advanced: [{ zoom: Math.min(2, caps.zoom.max) }] }).catch(() => {});
      }
    } catch { /* not supported */ }
  }

  loop() {
    if (!this.running) return;
    setTimeout(() => this.scanFrame().finally(() => this.loop()), 120);
  }

  async scanFrame() {
    const v = this.video;
    if (this.busy || !v.videoWidth) return;
    this.busy = true;
    try {
      // Read the middle band of the picture, where the guide box is.
      const w = v.videoWidth, h = v.videoHeight;
      const cropH = Math.round(h * 0.6);
      const cropY = Math.round((h - cropH) / 2);
      this.canvas.width = w;
      this.canvas.height = cropH;
      const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, cropY, w, cropH, 0, 0, w, cropH);
      const found = await this.detector.detect(this.canvas);
      if (this.running && found && found.length) {
        const code = found[0].rawValue;
        if (code) {
          if (navigator.vibrate) navigator.vibrate(60);
          this.stop();
          this.onCode(code);
        }
      }
    } catch { /* keep trying */ } finally {
      this.busy = false;
    }
  }

  stop() {
    this.running = false;
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
  }
}

// Reads a barcode from a still photo. Tries the photo as-is, then rotated,
// because people often hold the pack sideways.
export async function decodeFromFile(file) {
  const d = getDetector();
  const canvas = await canvasFromFile(file, CONFIG.BARCODE_PHOTO_MAX_SIDE);
  let found = await d.detect(canvas);
  if (!found.length) {
    const r = document.createElement('canvas');
    r.width = canvas.height;
    r.height = canvas.width;
    const ctx = r.getContext('2d');
    ctx.translate(r.width / 2, r.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    found = await d.detect(r);
  }
  return found.length ? found[0].rawValue : null;
}

// Load the decoder early so the first scan is quick.
export function warmUp() {
  try {
    const d = getDetector();
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    d.detect(c).catch(() => {});
  } catch { /* ignore */ }
}

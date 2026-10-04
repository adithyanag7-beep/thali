// Shrinks photos on the phone before they're sent or stored.

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve({ img, url }); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This photo could not be opened. Try another one.')); };
    img.src = url;
  });
}

function drawScaled(source, w, h, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // flatten transparent PNGs onto white
  ctx.fillRect(0, 0, cw, ch);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, cw, ch);
  return canvas;
}

// Returns { dataUrl, base64, width, height } as JPEG. Safari applies the photo's
// rotation (EXIF) when drawing, so portrait photos stay upright.
export async function compressPhoto(file, maxSide, quality) {
  const { img, url } = await loadImage(file);
  try {
    const canvas = drawScaled(img, img.naturalWidth, img.naturalHeight, maxSide);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    return { dataUrl, base64: dataUrl.split(',')[1], width: canvas.width, height: canvas.height, canvas };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function thumbFromCanvas(canvas, maxSide, quality) {
  const small = drawScaled(canvas, canvas.width, canvas.height, maxSide);
  return small.toDataURL('image/jpeg', quality);
}

export async function canvasFromFile(file, maxSide) {
  const { img, url } = await loadImage(file);
  try {
    return drawScaled(img, img.naturalWidth, img.naturalHeight, maxSide);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// In-app camera only: Kuhit never offers a gallery upload, so every selfie is taken live.

export async function openCamera(video, facing = 'user') {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('no-camera');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 1280 } },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play().catch(() => {});
  const stop = () => stream.getTracks().forEach((t) => t.stop());
  stop.stream = stream;
  return stop;
}

// Center-square crop of the current frame, as a JPEG data URL (stays under 1 MB for Firestore).
export function captureSquare(video, size = 480, mirror = true) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return null;
  const s = Math.min(w, h);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  if (mirror) { ctx.translate(size, 0); ctx.scale(-1, 1); }
  ctx.drawImage(video, (w - s) / 2, (h - s) / 2, s, s, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.82);
}

// Center crop at the video's aspect (for the ID scan), smaller, never stored.
export function captureFrame(video, maxW = 900) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return null;
  const scale = Math.min(1, maxW / w);
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

// The version other people see before a mutual kuhit: a 12 x 12 pixel thumbnail.
// It is blurred again on screen, and it carries too little detail to recognise anyone,
// so the clear selfie never has to be sent to people who haven't matched.
export function blurThumb(dataUrl, size = 12) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      ctx.filter = 'blur(1px)';
      ctx.drawImage(img, 0, 0, size, size);
      resolve(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

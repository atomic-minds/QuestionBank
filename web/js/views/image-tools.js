// Shrinks a photo in the browser before upload: smaller upload, faster AI, and the free quota goes
// further. The original file never leaves the device and nothing is stored anywhere.
const MAX_SIDE = 1800;
const MAX_BYTES = 2.5 * 1024 * 1024;

export async function prepareImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Choose a JPEG, PNG or WebP image.');
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { throw new Error('That image could not be read. Try another file.'); }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);      // transparent PNGs become white, not black
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  for (const q of [0.9, 0.8, 0.7, 0.55]) {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= MAX_BYTES) return blob;
  }
  throw new Error('That image is too large even after shrinking. Crop it to a few questions.');
}

// ------------------------------------------------------------------ pictures that belong to a question
// A figure (structure, apparatus, graph) is cropped and shrunk on the device, then stored with the
// question as a small WebP/JPEG (about 20-80 KB). Limits mirror the database (about 160 KB).
const FIG_SIDES = [800, 640, 480];
const FIG_QUALITY = [0.85, 0.7, 0.55];
export const FIG_MAX_BYTES = 110 * 1024;

const toBlob = (canvas, type, q) => new Promise((r) => canvas.toBlob(r, type, q));
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '');
    fr.onerror = () => reject(new Error('That picture could not be read.'));
    fr.readAsDataURL(blob);
  });
}
export const figureUrl = (img) => `data:${img.mime};base64,${img.data}`;

/** @param {ImageBitmap} bmp @param {{x:number,y:number,w:number,h:number}|null} rect in bitmap pixels */
export async function bitmapToFigure(bmp, rect = null) {
  const sx = rect ? rect.x : 0; const sy = rect ? rect.y : 0;
  const sw = rect ? rect.w : bmp.width; const sh = rect ? rect.h : bmp.height;
  for (const side of FIG_SIDES) {
    const scale = Math.min(1, side / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale)); const h = Math.max(1, Math.round(sh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
    for (const q of FIG_QUALITY) {
      let blob = await toBlob(canvas, 'image/webp', q);
      if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', q);   // older Safari cannot write WebP
      if (blob && blob.size <= FIG_MAX_BYTES) {
        const data = await blobToBase64(blob);
        return { mime: blob.type, data, bytes: blob.size };
      }
    }
  }
  throw new Error('That picture is too detailed to store. Crop a smaller part of it.');
}

/** Pick a file, crop it (optional) and return a stored-size figure, or null if the person cancelled. */
export async function figureFromBlob(blob, opts) {
  const sel = await cropDialog(blob, opts);
  if (!sel) return null;
  try { return await bitmapToFigure(sel.bitmap, sel.rect); } finally { sel.bitmap.close?.(); }
}

/**
 * Shows the picture and lets the person drag a box around the part to keep.
 * @returns {Promise<{bitmap: ImageBitmap, rect: {x,y,w,h}|null}|null>}
 */
export async function cropDialog(blob, { title = 'Choose the part to keep' } = {}) {
  let bitmap;
  try { bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { throw new Error('That image could not be read. Try another file.'); }
  const { html } = await import('../dom.js');
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'crop-dialog';
    d.innerHTML = html`<form method="dialog"><h3>${title}</h3>
      <p class="hint">Drag on the picture to draw a box around the figure. Or keep the whole picture.</p>
      <div class="crop-stage"><canvas data-crop aria-label="Picture. Drag to choose the part to keep."></canvas></div>
      <p class="hint" data-crop-note>Nothing selected yet.</p>
      <div class="row"><button class="btn-primary" value="part" data-use-part disabled>Use the selected part</button><button value="whole" type="submit">Use the whole picture</button><button value="cancel" formnovalidate>Cancel</button></div></form>`.toString();
    document.body.append(d);
    const canvas = d.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const stageW = () => Math.max(160, Math.min(bitmap.width, (d.querySelector('.crop-stage').clientWidth || 320)));
    let scale = 1;
    let box = null;            // in canvas pixels
    let start = null;

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (!box) return;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, box.x / scale, box.y / scale, box.w / scale, box.h / scale, box.x, box.y, box.w, box.h);
      ctx.strokeStyle = '#ff6aa8'; ctx.lineWidth = 2; ctx.strokeRect(box.x + 1, box.y + 1, box.w - 2, box.h - 2);
      ctx.restore();
    };
    const size = () => {
      const w = stageW();
      scale = w / bitmap.width;
      canvas.width = Math.round(w); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.style.width = `${canvas.width}px`; canvas.style.height = `${canvas.height}px`;
      draw();
    };
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      const x = Math.min(Math.max(0, (e.clientX - r.left) * (canvas.width / r.width)), canvas.width);
      const y = Math.min(Math.max(0, (e.clientY - r.top) * (canvas.height / r.height)), canvas.height);
      return { x, y };
    };
    const note = d.querySelector('[data-crop-note]');
    const use = d.querySelector('[data-use-part]');
    const update = () => {
      const ok = box && box.w >= 16 && box.h >= 16;
      use.disabled = !ok;
      note.textContent = ok ? `Selected: ${Math.round(box.w / scale)} × ${Math.round(box.h / scale)} px.` : 'Nothing selected yet.';
    };
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); start = pos(e); box = { x: start.x, y: start.y, w: 0, h: 0 }; draw(); update(); });
    canvas.addEventListener('pointermove', (e) => {
      if (!start) return;
      const p = pos(e);
      box = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      draw(); update();
    });
    const end = () => { start = null; update(); };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    d.addEventListener('close', () => {
      const v = d.returnValue;
      d.remove();
      if (v === 'whole') resolve({ bitmap, rect: null });
      else if (v === 'part' && box && box.w >= 16 && box.h >= 16) {
        const x = Math.round(box.x / scale); const y = Math.round(box.y / scale);
        resolve({ bitmap, rect: { x, y, w: Math.min(bitmap.width - x, Math.round(box.w / scale)), h: Math.min(bitmap.height - y, Math.round(box.h / scale)) } });
      } else { bitmap.close?.(); resolve(null); }
    });
    d.showModal();
    size();
  });
}

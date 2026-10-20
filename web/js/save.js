// Save layer for Panelscape: format table, file builders, file names and
// saving to a chosen folder (File System Access API) or to Downloads.
//
// Folder saving needs Chromium-based browsers (showDirectoryPicker and
// showSaveFilePicker). Elsewhere, and in private windows where IndexedDB is
// blocked, saves fall back to a normal browser download.

import {
  renderRasterBlob,
  svgBlob,
  glbBlob,
  fbxBlob,
  objZipBlob,
} from './export.js';

const DB_NAME = 'panelscape';
const DB_STORE = 'handles';
const DB_KEY = 'saveFolder';
const PICKER_ID = 'panelscape-saves';
const NAME_MAX = 60;
const REVOKE_MS = 30000;

export const FORMATS = [
  { id: 'png', label: 'PNG', ext: 'png', mime: 'image/png', kind: 'raster' },
  { id: 'jpeg', label: 'JPEG', ext: 'jpg', mime: 'image/jpeg', kind: 'raster' },
  { id: 'webp', label: 'WebP', ext: 'webp', mime: 'image/webp', kind: 'raster' },
  { id: 'svg', label: 'SVG (line art)', ext: 'svg', mime: 'image/svg+xml', kind: 'vector' },
  { id: 'glb', label: 'GLB (3D)', ext: 'glb', mime: 'model/gltf-binary', kind: 'model' },
  { id: 'fbx', label: 'FBX (3D)', ext: 'fbx', mime: 'application/octet-stream', kind: 'model' },
  { id: 'obj', label: 'OBJ (3D · ZIP)', ext: 'zip', mime: 'application/zip', kind: 'model' },
];

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

function resolveFormat(format) {
  if (typeof format === 'string') {
    const f = FORMATS.find((x) => x.id === format);
    if (!f) throw new Error(`save: unknown format "${format}"`);
    return f;
  }
  return format;
}

/**
 * Build the file for a format. Returns { blob, ext }. `ext` follows the blob that
 * was actually produced, so a browser that cannot encode WebP gives a PNG named .png.
 * opts: { longSide, transparent, credit, quality (0-1), includeSurroundings }.
 */
export async function makeFile(renderer, format, opts = {}) {
  const f = resolveFormat(format);
  if (f.kind === 'raster') {
    const blob = await renderRasterBlob(renderer, {
      mime: f.mime,
      quality: opts.quality,
      longSide: opts.longSide,
      transparent: opts.transparent,
      credit: opts.credit,
    });
    const ext = blob.type && blob.type !== f.mime ? EXT_BY_MIME[blob.type] || f.ext : f.ext;
    return { blob, ext };
  }
  switch (f.id) {
    case 'svg':
      return { blob: await svgBlob(renderer), ext: f.ext };
    case 'glb':
      return { blob: await glbBlob(renderer, { includeSurroundings: !!opts.includeSurroundings }), ext: f.ext };
    case 'fbx':
      return { blob: await fbxBlob(renderer, { includeSurroundings: !!opts.includeSurroundings }), ext: f.ext };
    case 'obj':
      return { blob: await objZipBlob(renderer, { includeSurroundings: !!opts.includeSurroundings }), ext: f.ext };
    default:
      throw new Error(`save: unsupported format "${f.id}"`);
  }
}

/* ----------------------------------------------------------------------------
 * File names
 * ------------------------------------------------------------------------- */

const pad2 = (n) => String(n).padStart(2, '0');

/** Local time as YYYYMMDD-HHmm. */
function stamp(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}

/** Keep letters, numbers, combining marks, "-" and "_"; runs of anything else become "-". */
function sanitizePart(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\p{M}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * File name for a save, e.g. `Shibuya-Crossing-Tokyo_lines-tone_20261019-1342.png`.
 * The place part is at most 60 characters; Unicode letters (Japanese names) are kept.
 */
export function suggestedName(placeName, style, ext, date = new Date()) {
  const place = sanitizePart(placeName).slice(0, NAME_MAX).replace(/-+$/g, '') || 'place';
  const styleKey = sanitizePart(style) || 'style';
  const extension = String(ext || '').replace(/^\./, '');
  return `${place}_${styleKey}_${stamp(date)}${extension ? `.${extension}` : ''}`;
}

/* ----------------------------------------------------------------------------
 * Persistence of the chosen folder handle (IndexedDB, with a session fallback)
 * ------------------------------------------------------------------------- */

// Used when IndexedDB is unavailable (private windows): the folder lasts for this page.
let sessionHandle = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

async function withStore(mode, fn) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      const store = tx.objectStore(DB_STORE);
      const req = fn(store);
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

async function loadFolderHandle() {
  try {
    const handle = await withStore('readonly', (s) => s.get(DB_KEY));
    if (handle) return handle;
  } catch {
    // No IndexedDB (private window, blocked storage): use the session copy.
  }
  return sessionHandle;
}

/** Remember the folder; returns false when it could only be kept for this session. */
async function storeFolderHandle(handle) {
  sessionHandle = handle;
  try {
    await withStore('readwrite', (s) => s.put(handle, DB_KEY));
    return true;
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------------------
 * Folder API
 * ------------------------------------------------------------------------- */

/** True when folder saving (showDirectoryPicker) is available. */
export function supportsFolders() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/** Ask the user for a destination folder and remember it. Returns its name, or null when cancelled. */
export async function chooseFolder() {
  if (!supportsFolders()) return null;
  let dir;
  try {
    dir = await window.showDirectoryPicker({ mode: 'readwrite', id: PICKER_ID });
  } catch {
    return null; // cancelled or refused
  }
  await storeFolderHandle(dir);
  return dir.name;
}

/** Name of the remembered folder, or null. */
export async function currentFolder() {
  const handle = await loadFolderHandle();
  return handle ? handle.name : null;
}

/** Check (and if needed request) readwrite permission on a folder handle. */
async function ensureWritable(dir) {
  const opts = { mode: 'readwrite' };
  try {
    if (typeof dir.queryPermission === 'function' && (await dir.queryPermission(opts)) === 'granted') return true;
    if (typeof dir.requestPermission === 'function') return (await dir.requestPermission(opts)) === 'granted';
    return true;
  } catch {
    return false;
  }
}

async function exists(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (err) {
    if (err && err.name === 'NotFoundError') return false;
    if (err && err.name === 'TypeMismatchError') return true; // a folder has that name
    throw err;
  }
}

/** `name`, or `name (2)`, `name (3)`… when a file with that name already exists. */
async function uniqueName(dir, name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 10000; i++) {
    const candidate = i === 1 ? name : `${base} (${i})${ext}`;
    if (!(await exists(dir, candidate))) return candidate;
  }
  throw new Error('save: too many files with the same name');
}

/* ----------------------------------------------------------------------------
 * Saving
 * ------------------------------------------------------------------------- */

/** Save through an object URL and a temporary <a download>. */
function downloadFallback(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
  return { where: 'download', name };
}

async function writeBlob(fileHandle, blob) {
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (err) {
    try {
      await writable.abort();
    } catch {
      // already closed or failed; nothing else to undo
    }
    throw err;
  }
}

async function saveToFolder(blob, name) {
  const dir = await loadFolderHandle();
  if (!dir || !supportsFolders()) return null;
  if (!(await ensureWritable(dir))) return null;
  const finalName = await uniqueName(dir, name);
  const fileHandle = await dir.getFileHandle(finalName, { create: true });
  await writeBlob(fileHandle, blob);
  return { where: 'folder', name: finalName };
}

async function saveWithPicker(blob, name) {
  if (typeof window === 'undefined' || typeof window.showSaveFilePicker !== 'function') {
    return downloadFallback(blob, name);
  }
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const mime = blob.type || 'application/octet-stream';
  const options = {
    suggestedName: name,
    types: [{ description: 'Panelscape file', accept: { [mime]: [ext || '.bin'] } }],
  };
  const startIn = await loadFolderHandle();
  if (startIn) options.startIn = startIn;

  let fileHandle;
  try {
    fileHandle = await window.showSaveFilePicker(options);
  } catch (err) {
    if (err && err.name === 'AbortError') return { where: 'cancelled' };
    return downloadFallback(blob, name); // refused or not allowed here
  }
  await writeBlob(fileHandle, blob);
  return { where: 'picked', name: fileHandle.name };
}

/**
 * Save a blob.
 *  - mode 'auto': write into the remembered folder (new name if taken), else download.
 *  - mode 'picker': show the browser's save dialog, else download.
 * Returns { where: 'folder' | 'picked' | 'download', name } or { where: 'cancelled' }.
 *
 * Note: re-granting folder permission needs a user gesture. Call saveFile straight
 * from the click handler where possible; a long render first can let the gesture expire.
 */
export async function saveFile(blob, name, mode = 'auto') {
  if (mode === 'picker') return saveWithPicker(blob, name);
  const saved = await saveToFolder(blob, name);
  return saved || downloadFallback(blob, name);
}

/* ----------------------------------------------------------------------------
 * Two-phase saving (use this from click handlers)
 *
 * Browsers only allow the save dialog and the folder-permission prompt during the click
 * itself ("transient user activation"). Rendering a big image first can take seconds and
 * let that expire, so: prepareSave() right away in the handler, render, then commitSave().
 * ------------------------------------------------------------------------- */

/**
 * Resolve where a file will go, while the click is still active.
 * Returns { kind: 'picked', handle } | { kind: 'folder', dir } | { kind: 'download' } | { kind: 'cancelled' }.
 */
export async function prepareSave(name, format, mode = 'auto') {
  const fmt = resolveFormat(format) || FORMATS[0];
  if (mode === 'picker') {
    if (typeof window === 'undefined' || typeof window.showSaveFilePicker !== 'function') return { kind: 'download' };
    const options = {
      suggestedName: name,
      types: [{ description: fmt.label, accept: { [fmt.mime]: ['.' + fmt.ext] } }],
    };
    const startIn = await loadFolderHandle();
    if (startIn) options.startIn = startIn;
    try {
      return { kind: 'picked', handle: await window.showSaveFilePicker(options) };
    } catch (err) {
      if (err && err.name === 'AbortError') return { kind: 'cancelled' };
      return { kind: 'download' };
    }
  }
  const dir = supportsFolders() ? await loadFolderHandle() : null;
  if (dir && (await ensureWritable(dir))) return { kind: 'folder', dir };
  return { kind: 'download' };
}

/** Write blob to a target from prepareSave. name is the file name for folder/download targets. */
export async function commitSave(target, blob, name) {
  if (target.kind === 'cancelled') return { where: 'cancelled' };
  if (target.kind === 'picked') {
    await writeBlob(target.handle, blob);
    return { where: 'picked', name: target.handle.name };
  }
  if (target.kind === 'folder') {
    const finalName = await uniqueName(target.dir, name);
    await writeBlob(await target.dir.getFileHandle(finalName, { create: true }), blob);
    return { where: 'folder', name: finalName };
  }
  return downloadFallback(blob, name);
}

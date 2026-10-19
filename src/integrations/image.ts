import type { CvAdapter, CvFrame } from './cv';

const MAX_IMAGES = 5;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const acceptedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface ImageDependencies {
  now: () => number;
  prepareImage: (file: File) => Promise<Blob>;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.76));
}

/** Decode an uploaded image, strip metadata and normalize it to the gateway's JPEG boundary. */
export async function normalizeUploadedImage(file: File): Promise<Blob> {
  if (!acceptedTypes.has(file.type) || file.size < 1 || file.size > MAX_INPUT_BYTES) throw new Error('Invalid image input');
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width < 40 || bitmap.height < 40 || bitmap.width * bitmap.height > MAX_INPUT_PIXELS) throw new Error('Invalid image dimensions');
    const scale = Math.min(1, 320 / bitmap.width, 240 / bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Image processing is unavailable');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const output = await canvasBlob(canvas);
    if (!output || output.type !== 'image/jpeg' || output.size < 4 || output.size > MAX_OUTPUT_BYTES) throw new Error('Image output is invalid');
    return output;
  } finally {
    bitmap.close();
  }
}

/**
 * One-shot image adapter used while the live-camera path is deferred.
 * Prepared images stay in memory until the next spoken turn, replacement or call end.
 */
export function createImageCvAdapter(overrides: Partial<ImageDependencies> = {}): CvAdapter {
  const deps: ImageDependencies = { now: Date.now, prepareImage: normalizeUploadedImage, ...overrides };
  let images: Blob[] = [];
  let active = false;
  let generation = 0;
  let removeAbortListener: (() => void) | null = null;

  function stop() {
    generation++;
    removeAbortListener?.();
    removeAbortListener = null;
    active = false;
    images = [];
  }

  return {
    requiresAnalysisService: true,
    stop,
    async setImages(files) {
      if (files.length < 2 || files.length > MAX_IMAGES) throw new RangeError('Select two to five images');
      const run = ++generation;
      const prepared = await Promise.all(files.map(file => deps.prepareImage(file)));
      if (run !== generation) throw new DOMException('Aborted', 'AbortError');
      if (prepared.some(image => image.type !== 'image/jpeg' || image.size < 4 || image.size > MAX_OUTPUT_BYTES)) throw new Error('Invalid prepared image');
      images = prepared;
      return images.length;
    },
    async start({ signal }) {
      removeAbortListener?.();
      removeAbortListener = null;
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (images.length < 2) throw new Error('No image batch is ready');
      const abort = () => stop();
      signal.addEventListener('abort', abort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', abort);
      active = true;
    },
    takeFrames(): CvFrame[] {
      if (!active || images.length < 2) return [];
      const capturedAt = deps.now();
      const result = images.map(image => ({ image, capturedAt }));
      removeAbortListener?.();
      removeAbortListener = null;
      images = [];
      active = false;
      return result;
    },
  };
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImageCvAdapter, normalizeUploadedImage } from '../src/integrations/image';

const source = (name: string) => new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/png' });
const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
afterEach(() => vi.unstubAllGlobals());

describe('uploaded-image normalization', () => {
  it('re-encodes without metadata and bounds the image dimensions', async () => {
    const drawImage = vi.fn(); const close = vi.fn();
    const canvas = {
      width: 0, height: 0, getContext: vi.fn(() => ({ drawImage })),
      toBlob: vi.fn((done: BlobCallback) => done(jpeg())),
    } as unknown as HTMLCanvasElement;
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 640, height: 480, close })));
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
    const output = await normalizeUploadedImage(source('face.png'));
    expect(output.type).toBe('image/jpeg');
    expect(canvas.width).toBe(320); expect(canvas.height).toBe(240);
    expect(drawImage).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });

  it('rejects unsupported source formats before decoding', async () => {
    const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode);
    await expect(normalizeUploadedImage(new File(['data'], 'face.gif', { type: 'image/gif' }))).rejects.toThrow('Invalid image input');
    expect(decode).not.toHaveBeenCalled();
  });
});

describe('one-shot uploaded-image adapter', () => {
  it('prepares two to five images and consumes them on the next turn', async () => {
    const prepareImage = vi.fn(async () => jpeg());
    const adapter = createImageCvAdapter({ prepareImage, now: () => 1_800_000_000_000 });
    expect(await adapter.setImages?.([source('one.png'), source('two.png')])).toBe(2);
    const run = new AbortController();
    await adapter.start({ signal: run.signal, onObservation: vi.fn() });
    expect(await adapter.takeFrames?.()).toEqual([
      { image: expect.any(Blob), capturedAt: 1_800_000_000_000 },
      { image: expect.any(Blob), capturedAt: 1_800_000_000_000 },
    ]);
    expect(await adapter.takeFrames?.()).toEqual([]);
    expect(prepareImage).toHaveBeenCalledTimes(2);
  });

  it('rejects incomplete or oversized batches before decoding', async () => {
    const prepareImage = vi.fn(async () => jpeg());
    const adapter = createImageCvAdapter({ prepareImage });
    await expect(adapter.setImages?.([source('only.png')])).rejects.toBeInstanceOf(RangeError);
    await expect(adapter.setImages?.(Array.from({ length: 6 }, (_, index) => source(`${index}.png`)))).rejects.toBeInstanceOf(RangeError);
    expect(prepareImage).not.toHaveBeenCalled();
  });

  it('clears prepared images when the call is stopped or aborted', async () => {
    const adapter = createImageCvAdapter({ prepareImage: async () => jpeg() });
    await adapter.setImages?.([source('one.png'), source('two.png')]);
    const run = new AbortController();
    await adapter.start({ signal: run.signal, onObservation: vi.fn() });
    run.abort();
    expect(await adapter.takeFrames?.()).toEqual([]);
    await adapter.stop();
    expect(await adapter.takeFrames?.()).toEqual([]);
  });

  it('does not retain images that finish processing after stop', async () => {
    let finish!: (value: Blob) => void;
    const pending = new Promise<Blob>(resolve => { finish = resolve; });
    const adapter = createImageCvAdapter({ prepareImage: () => pending });
    const preparing = adapter.setImages?.([source('one.png'), source('two.png')]);
    await adapter.stop();
    finish(jpeg());
    await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    expect(await adapter.takeFrames?.()).toEqual([]);
  });
});

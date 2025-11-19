import type { EdgeBlock } from './schema';

function viewToArrayBuffer(view: ArrayBufferView): ArrayBuffer {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function buildHeader(block: EdgeBlock) {
  const cols = ['neighbor', 'type', 'weight', 'lastSeen'];
  if (block.flags) cols.push('flags');
  const header = {
    v: 1,
    tokenId: block.tokenId,
    part: block.part,
    count: block.count,
    cols,
  };
  return new TextEncoder().encode(JSON.stringify(header));
}

export async function encodeEdgeBlock(block: EdgeBlock, compress = true): Promise<Blob> {
  const headerBytes = buildHeader(block);
  const buffers: ArrayBuffer[] = [
    new Uint32Array([headerBytes.byteLength]).buffer,
    viewToArrayBuffer(headerBytes),
    viewToArrayBuffer(block.neighbor),
    viewToArrayBuffer(block.type),
    viewToArrayBuffer(block.weight),
    viewToArrayBuffer(block.lastSeen),
  ];

  if (block.flags) {
    buffers.push(viewToArrayBuffer(block.flags));
  } else {
    buffers.push(new Uint8Array(0).buffer);
  }

  const blob = new Blob(buffers, { type: 'application/octet-stream' });
  if (!compress) return blob;

  if (typeof CompressionStream !== 'undefined' && typeof (CompressionStream as any) === 'function') {
    const stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
    const response = new Response(stream);
    return response.blob();
  }

  return blob;
}

async function maybeDecompress(blob: Blob): Promise<ArrayBuffer> {
  if (typeof DecompressionStream !== 'undefined' && typeof (DecompressionStream as any) === 'function') {
    try {
      const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
      return await new Response(stream).arrayBuffer();
    } catch {
      // If gzip header missing, fall back to raw array buffer.
    }
  }
  return await blob.arrayBuffer();
}

export async function decodeEdgeBlock(blob: Blob): Promise<EdgeBlock> {
  const ab = await maybeDecompress(blob);
  const dv = new DataView(ab);
  let offset = 0;
  const headerSize = dv.getUint32(offset, true); offset += 4;
  const headerBytes = new Uint8Array(ab, offset, headerSize);
  offset += headerSize;
  const header = JSON.parse(new TextDecoder().decode(headerBytes));
  const { tokenId, part, count } = header;

  const neighbor = new Uint32Array(ab, offset, count); offset += neighbor.byteLength;
  const type = new Uint16Array(ab, offset, count); offset += type.byteLength;
  const weight = new Uint32Array(ab, offset, count); offset += weight.byteLength;
  const lastSeen = new Uint32Array(ab, offset, count); offset += lastSeen.byteLength;

  const remaining = ab.byteLength - offset;
  const flags = remaining >= count && count > 0 ? new Uint8Array(ab, offset, count) : undefined;

  return { tokenId, part, count, neighbor, type, weight, lastSeen, flags };
}

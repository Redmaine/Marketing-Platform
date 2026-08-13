// Statically imported (not Deno.readFile) so Supabase's function-deploy
// bundler — which only traces real import statements, not dynamic runtime
// file reads — actually includes the wasm bytes. See ../../README.md.
import wasmB64 from './tiff.wasm.b64.ts'
let wasm_mod;
let ref = { deref() {} };

wasm_mod = new WebAssembly.Module(Uint8Array.from(atob(wasmB64), (c) => c.charCodeAt(0)));

function wasm() {
  return ref.deref() || (ref = new WeakRef(new WebAssembly.Instance(wasm_mod).exports)).deref();
}

class mem {
  static length() { return wasm().wlen(); }
  static alloc(size) { return wasm().walloc(size); }
  static free(ptr, size) { return wasm().wfree(ptr, size); }
  static u8(ptr, size) { return new Uint8Array(wasm().memory.buffer, ptr, size); }
  static u32(ptr, size) { return new Uint32Array(wasm().memory.buffer, ptr, size); }

  static copy_and_free(ptr, size) {
    let slice = mem.u8(ptr, size).slice();
    return (wasm().wfree(ptr, size), slice);
  }
}

export function decode(buffer) {
  const _w = wasm();

  const bptr = mem.alloc(buffer.length);
  mem.u8(bptr, buffer.length).set(buffer);
  const ptr = wasm().decode(bptr, buffer.length);
  if (0 === ptr) throw new Error('tiff: failed to decode');

  const framebuffer = {
    width: wasm().decode_width(ptr),
    height: wasm().decode_height(ptr),
    buffer: mem.u8(wasm().decode_buffer(ptr), mem.length()).slice(),
  }

  return (wasm().decode_free(ptr), framebuffer);
}

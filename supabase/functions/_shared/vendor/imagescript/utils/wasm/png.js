// Statically imported (not Deno.readFile) so Supabase's function-deploy
// bundler — which only traces real import statements, not dynamic runtime
// file reads — actually includes the wasm bytes. See ../../README.md.
import wasmB64 from './png.wasm.b64.ts'
let wasm_mod;
let ref = { deref() { } };

wasm_mod = new WebAssembly.Module(Uint8Array.from(atob(wasmB64), (c) => c.charCodeAt(0)));

function wasm() {
  let u8;

  const {
    wfree, walloc, decode, memory,
    width: wwidth, height: wheight,
  } = new WebAssembly.Instance(wasm_mod, {
    env: {
      emscripten_notify_memory_growth() {
        u8 = new Uint8Array(memory.buffer);
      },
    },
  }).exports;

  u8 = new Uint8Array(memory.buffer);

  return {
    decode(buffer) {
      const ptr = walloc(buffer.length);

      u8.set(buffer, ptr);
      const status = decode(ptr, buffer.length);

      wfree(ptr);
      if (0 > status) throw new Error(`png: failed to decode (${status})`);

      const width = wwidth();
      const height = wheight();
      const framebuffer = u8.slice(status, status + 4 * width * height);

      wfree(status);
      return { width, height, framebuffer };
    },
  };
}

export function decode(buffer) {
  return (ref.deref() || (ref = new WeakRef(wasm())).deref()).decode(buffer);
}
// The pinned third-party files the page loads, in one place (data only, no side effects).
// fetch-vendor.mjs downloads them, notices.mjs writes THIRD-PARTY-NOTICES.md and src/vendor.sha256 from them,
// fetch-vendor.mjs and CI verify the bytes against src/vendor.sha256.

/** npm packages at exact versions, and the files each one gives src/vendor/ (from its package folder → vendor name). */
export const PACKAGES = [
  { pkg: "colorjs.io", version: "0.7.1", files: { "dist/color-fn.js": "color-fn.js" } },
  { pkg: "lcms-wasm", version: "1.0.5", files: { "dist/lcms.js": "lcms.js", "dist/lcms.wasm": "lcms.wasm" } },
  { pkg: "pdf-lib", version: "1.17.1", files: { "dist/pdf-lib.min.js": "pdf-lib.min.js" } },
  { pkg: "jszip", version: "3.10.1", files: { "dist/jszip.min.js": "jszip.min.js" }, use: "MIT (dual licensed MIT OR GPL-3.0-or-later; used here under MIT)" },
  { pkg: "onnxruntime-web", version: "1.30.0", files: { "dist/ort.wasm.min.mjs": "ort.wasm.min.mjs", "dist/ort-wasm-simd-threaded.mjs": "ort-wasm-simd-threaded.mjs", "dist/ort-wasm-simd-threaded.wasm": "ort-wasm-simd-threaded.wasm" },
    licenseUrl: "https://cdn.jsdelivr.net/gh/microsoft/onnxruntime@v1.30.0/LICENSE" },
  { pkg: "@techstark/opencv-js", version: "4.10.0-release.1", files: { "dist/opencv.js": "opencv.js" } },
  { pkg: "vtracer-wasm", version: "0.1.0", files: { "vtracer.js": "vtracer.js", "vtracer.wasm": "vtracer.wasm" }, license: "MIT" },
  // bundled by esbuild into src/vendor/quickhull.js with the packages it imports (notices.mjs reads them from the build's metafile)
  { pkg: "quickhull3d", version: "3.1.2", bundle: "quickhull.js" },
  // build tool only: nothing of it is served
  { pkg: "esbuild", version: "0.24.0", tool: true },
];

/** Models: fixed URLs. The SHA-256 in src/vendor.sha256 is what makes each one a pin (a moved upstream file fails the check). */
export const MODELS = [
  { file: "u2netp.onnx", url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx", name: "U²-Net (u2netp)", license: "Apache-2.0", source: "https://github.com/xuebinqin/U-2-Net", use: "background removal" },
  { file: "sam_encoder.onnx", url: "https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/vision_encoder_quantized.onnx", name: "SlimSAM-77 vision encoder (quantized)", license: "Apache-2.0", source: "https://huggingface.co/Xenova/slimsam-77-uniform", use: "click-to-select a region" },
  { file: "sam_decoder.onnx", url: "https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/prompt_encoder_mask_decoder_quantized.onnx", name: "SlimSAM-77 prompt encoder and mask decoder (quantized)", license: "Apache-2.0", source: "https://huggingface.co/Xenova/slimsam-77-uniform", use: "click-to-select a region" },
  // built, not downloaded: export-sr-model.py; its hash pins the export the site serves
  { file: "sr_x2.onnx", built: "python3 -I scripts/export-sr-model.py", name: "Swin2SR lightweight x2 (exported by export-sr-model.py)", license: "Apache-2.0", source: "https://github.com/mv-lab/swin2sr", use: "2× upscale" },
];

/** Packages that ship no license file, in the package or its repository: what they do state, quoted. */
export const NO_LICENSE_FILE = {
  "point-line-distance": "The package and its repository (github.com/mauriciopoppe/point-line-distance, tag v1.0.1) ship no license file. Its package.json declares MIT and its README says: \"2015 MIT © Mauricio Poppe\".",
};

export const npmSpec = p => `${p.pkg}@${p.version}`;

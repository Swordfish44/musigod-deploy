"use strict";
const crypto = require("crypto"),
  { createCanvas } = require("@napi-rs/canvas"),
  { createWorker, OEM } = require("tesseract.js"),
  language = require("@tesseract.js-data/eng");
const OCR_ENGINE = "tesseract.js",
  OCR_VERSION = require("tesseract.js/package.json").version,
  RENDER_SCALE = 2,
  RENDER_DPI = 144;
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
async function createOcrWorker() {
  return createWorker(language.code, OEM.LSTM_ONLY, {
    langPath: language.langPath,
    gzip: language.gzip,
    cacheMethod: "none",
    logger: () => {},
  });
}
async function recognizeImage(image, { worker = null } = {}) {
  const owned = !worker,
    w = worker || (await createOcrWorker());
  try {
    const result = await w.recognize(
        image,
        {},
        { text: true, blocks: true, tsv: true },
      ),
      data = result.data,
      rows = linesFromBlocks(data.blocks || []);
    return {
      engine: OCR_ENGINE,
      engine_version: OCR_VERSION,
      language: language.code,
      confidence: Number(data.confidence || 0),
      text: String(data.text || "").trim(),
      text_hash: sha256(String(data.text || "")),
      rows,
    };
  } finally {
    if (owned) await w.terminate();
  }
}
async function recognizePdfPages(pdfBuffer, pageNumbers) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"),
    document = await pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer),
      disableWorker: true,
      isEvalSupported: false,
      useSystemFonts: false,
    }).promise,
    worker = await createOcrWorker(),
    outputs = [];
  try {
    for (const pageNumber of pageNumbers) {
      const page = await document.getPage(pageNumber),
        viewport = page.getViewport({ scale: RENDER_SCALE }),
        canvas = createCanvas(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        ),
        context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const image = canvas.toBuffer("image/png"),
        ocr = await recognizeImage(image, { worker });
      outputs.push({
        ...ocr,
        page_number: pageNumber,
        dpi: RENDER_DPI,
        image_width: canvas.width,
        image_height: canvas.height,
        image_hash: sha256(image),
      });
    }
  } finally {
    await worker.terminate();
  }
  return outputs;
}
function linesFromBlocks(blocks) {
  const lines = [];
  for (const block of blocks || [])
    for (const paragraph of block.paragraphs || [])
      for (const line of paragraph.lines || []) {
        const words = line.words || [],
          text =
            words
              .map((x) => x.text)
              .join(" ")
              .trim() || String(line.text || "").trim();
        if (!text) continue;
        const b = line.bbox || bounds(words.map((x) => x.bbox).filter(Boolean));
        lines.push({
          row_number: lines.length + 1,
          text,
          values: words.length ? words.map((x) => x.text) : [text],
          confidence: Number(
            line.confidence ?? average(words.map((x) => x.confidence)),
          ),
          bounds: b ? { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } : null,
        });
      }
  return lines;
}
function bounds(values) {
  if (!values.length) return null;
  return {
    x0: Math.min(...values.map((x) => x.x0)),
    y0: Math.min(...values.map((x) => x.y0)),
    x1: Math.max(...values.map((x) => x.x1)),
    y1: Math.max(...values.map((x) => x.y1)),
  };
}
function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
}
module.exports = {
  OCR_ENGINE,
  OCR_VERSION,
  RENDER_SCALE,
  RENDER_DPI,
  sha256,
  createOcrWorker,
  recognizeImage,
  recognizePdfPages,
  linesFromBlocks,
};

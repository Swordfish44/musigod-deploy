"use strict";
const assert = require("assert"),
  fs = require("fs"),
  path = require("path"),
  { createCanvas } = require("@napi-rs/canvas"),
  ocr = require("../lib/ocr-execution");
const root = path.join(__dirname, ".."),
  migration = fs.readFileSync(
    path.join(
      root,
      "supabase/migrations/20260830000001_real_ocr_execution_v1.sql",
    ),
    "utf8",
  ),
  runner = fs.readFileSync(
    path.join(root, "api/admin/run-ingestion-worker.js"),
    "utf8",
  ),
  api = fs.readFileSync(path.join(root, "api/statement-ingestion.js"), "utf8");
for (const value of [
  "ocr_executions_v1",
  "ENABLE ROW LEVEL SECURITY",
  "OCR evidence is append-only",
  "generic_pdf_ocr",
  "confidence_review_threshold",
  "human_review_required",
])
  assert(migration.includes(value));
for (const value of [
  "recognizePdfPages",
  "OCR_LOW_CONFIDENCE",
  "OCR_REVIEW_REQUIRED",
  "PENDING_REVIEW",
])
  assert(runner.includes(value));
for (const value of [
  "action==='review_ocr'",
  "ocr_execution_id",
  "Named administrative reviewer",
  "statement_ocr.",
])
  assert(api.includes(value));
async function test() {
  const canvas = createCanvas(1400, 220),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#111";
  ctx.font = "bold 64px sans-serif";
  ctx.fillText("Tha Regime  $1,234.56  USD", 40, 135);
  const result = await ocr.recognizeImage(canvas.toBuffer("image/png"));
  assert.match(result.text, /Tha Regime/i);
  assert.match(result.text, /1,?234\.56/);
  assert(
    result.confidence >= 70,
    `unexpected OCR confidence ${result.confidence}`,
  );
  assert.strictEqual(result.engine, "tesseract.js");
  assert.strictEqual(result.text_hash.length, 64);
  assert(result.rows.length > 0);
  assert(result.rows.some((x) => x.bounds && Number.isFinite(x.bounds.x0)));
  console.log(
    `real OCR execution: recognized synthetic royalty line at ${result.confidence.toFixed(2)}% confidence`,
  );
}
test().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

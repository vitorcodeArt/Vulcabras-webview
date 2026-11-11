// ======================================================
// RECEBIMENTO DAS FOTOS (multipart) NO SUBMIT
// ======================================================
// multer com memoryStorage e limites. O tipo é conferido pela assinatura do
// arquivo (JPEG, PNG, WebP), nunca pelo nome ou MIME enviados pelo navegador.
//
// Formato do multipart: campo "payload" (JSON com o mesmo corpo do submit) e
// arquivos nos campos "photos_<índice do item>".

const multer = require("multer");
const { ReverseError } = require("./errors");

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_FILES = 30;
const MAX_PER_ITEM = 10;
const FIELD_PATTERN = /^photos_(\d{1,2})$/;

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fields: 5, fieldSize: 200 * 1024, parts: MAX_FILES + 5 },
}).any();

function isMultipart(req) {
  return /^multipart\/form-data/i.test(req.get("Content-Type") || "");
}

// Agrupa os arquivos por índice do item: { [índice]: [{ buffer, mime }] }
function groupFiles(files) {
  const byIndex = {};
  let total = 0;
  for (const file of files || []) {
    const match = FIELD_PATTERN.exec(file.fieldname);
    if (!match) throw new ReverseError("PHOTO_INVALID", { field: "photos" });

    const mime = detectImageType(file.buffer);
    if (!mime) throw new ReverseError("PHOTO_INVALID", { field: `items[${match[1]}].photos` });

    total += file.buffer.length;
    if (total > MAX_TOTAL_BYTES) throw new ReverseError("PHOTO_TOO_LARGE", { field: "photos" });

    const list = (byIndex[match[1]] = byIndex[match[1]] || []);
    if (list.length >= MAX_PER_ITEM) throw new ReverseError("PHOTO_INVALID", { field: `items[${match[1]}].photos` });
    list.push({ buffer: file.buffer, mime });
  }
  return byIndex;
}

// Middleware do submit: com multipart, troca req.body pelo JSON do campo
// "payload" e coloca as fotos em req.photosByIndex. Sem multipart, segue igual.
function parseSubmitPayload(req, res, next) {
  if (!isMultipart(req)) return next();

  upload(req, res, (error) => {
    if (error) {
      req.uploadError = new ReverseError(error.code === "LIMIT_FILE_SIZE" ? "PHOTO_TOO_LARGE" : "PHOTO_INVALID", { field: "photos" });
      return next();
    }
    try {
      req.body = JSON.parse(req.body?.payload || "{}");
      req.photosByIndex = groupFiles(req.files);
    } catch (parseError) {
      req.uploadError = parseError instanceof ReverseError ? parseError : new ReverseError("INVALID_INPUT", { field: "payload" });
    }
    req.files = undefined;
    return next();
  });
}

module.exports = { detectImageType, groupFiles, parseSubmitPayload, MAX_PER_ITEM };

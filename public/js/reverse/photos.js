// ============================================================
// FOTOS NO NAVEGADOR
// Compressão antes de guardar na memória: lado maior até 1600 px, JPEG ~0,8.
// As fotos ficam só em memória (Blob) até a confirmação final.
// ============================================================

const MAX_SIDE = 1600;
const QUALITY = 0.8;
export const MAX_PHOTOS_PER_ITEM = 10;

function loadWithImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("imagem ilegível"));
    };
    img.src = url;
  });
}

async function decode(file) {
  if (typeof createImageBitmap === "function") {
    try {
      // Respeita a orientação da câmera (EXIF)
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Alguns navegadores não aceitam a opção: tenta pelo <img>
    }
  }
  return loadWithImageElement(file);
}

export async function compressImage(file) {
  const source = await decode(file);
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  if (!width || !height) throw new Error("imagem ilegível");

  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  // Fundo branco para PNG com transparência virar JPEG sem fundo preto
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (typeof source.close === "function") source.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
  if (!blob) throw new Error("falha ao comprimir");
  return blob;
}

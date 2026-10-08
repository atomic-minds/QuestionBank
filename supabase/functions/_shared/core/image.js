// Upload checks that do not trust the browser: size, declared type AND the file's real signature.
import { ALLOWED_IMAGE_TYPES, LIMITS } from './constants.js';
import { AppError } from './errors.js';

/** Look at the first bytes to decide what the file really is. */
export function sniffImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
      && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * @param {Uint8Array} bytes
 * @param {string} declaredType the Content-Type the browser sent
 * @returns {string} the verified MIME type
 */
export function verifyImage(bytes, declaredType) {
  if (bytes.length === 0) throw new AppError('BAD_REQUEST', 'The image is empty.');
  if (bytes.length > LIMITS.imageBytesMax) {
    throw new AppError('PAYLOAD_TOO_LARGE', `The image is larger than ${Math.round(LIMITS.imageBytesMax / 1024 / 1024)} MB. Use a smaller photo or crop it.`);
  }
  const real = sniffImageType(bytes);
  if (!real || !ALLOWED_IMAGE_TYPES.includes(real)) {
    throw new AppError('UNSUPPORTED_MEDIA', 'Only JPEG, PNG or WebP images are accepted.');
  }
  const declared = String(declaredType ?? '').split(';')[0].trim().toLowerCase();
  if (declared && declared !== real) {
    throw new AppError('UNSUPPORTED_MEDIA', 'The file contents do not match its type. Re-save the image as JPEG or PNG.');
  }
  return real;
}

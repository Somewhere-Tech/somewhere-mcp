import { safeFetch } from '../../worker/src/utils/safe-fetch';
import type {
  ConnectorFileDownloader,
  ConnectorFileReference,
  StorageRecord,
} from './types/file-upload';

const MAX_CONNECTOR_FILE_BYTES = 250 * 1024 * 1024;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  avif: 'image/avif',
  csv: 'text/csv',
  gif: 'image/gif',
  gz: 'application/gzip',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  md: 'text/markdown',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  otf: 'font/otf',
  pdf: 'application/pdf',
  png: 'image/png',
  rar: 'application/vnd.rar',
  svg: 'image/svg+xml',
  tar: 'application/x-tar',
  txt: 'text/plain',
  ttf: 'font/ttf',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
});

export class FileUploadError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly detail?: unknown;

  constructor(code: string, message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = 'FileUploadError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function parseConnectorFileReference(input: unknown, fieldName = 'file'): ConnectorFileReference {
  if (typeof input === 'string') {
    throw new FileUploadError(
      'FILE_REFERENCE_REQUIRED',
      `${fieldName} must be a connector-provided file reference, not a path, base64 string, or text value.`,
      400,
    );
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new FileUploadError(
      'FILE_REFERENCE_REQUIRED',
      `${fieldName} must be a connector-provided file reference.`,
      400,
    );
  }

  const value = input as Record<string, unknown>;
  const downloadUrl = nonEmptyString(value.download_url);
  const fileId = nonEmptyString(value.file_id);
  if (!downloadUrl || !fileId) {
    throw new FileUploadError(
      'FILE_REFERENCE_INVALID',
      `${fieldName} must include connector-issued download_url and file_id values.`,
      400,
    );
  }

  const mimeType = nonEmptyString(value.mime_type);
  const fileName = nonEmptyString(value.file_name);
  return {
    download_url: downloadUrl,
    file_id: fileId,
    ...(mimeType ? { mime_type: mimeType } : {}),
    ...(fileName ? { file_name: fileName } : {}),
  };
}

export function parseConnectorFileReferences(input: unknown): ConnectorFileReference[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new FileUploadError(
      'FILE_REFERENCES_REQUIRED',
      'upload_attachments must be a non-empty array of connector-provided file references.',
      400,
    );
  }
  return input.map((item, index) => parseConnectorFileReference(item, `upload_attachments[${index}]`));
}

function normalizeContentType(value: string | undefined): string | null {
  if (!value) return null;
  const base = value.split(';', 1)[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base)) {
    throw new FileUploadError('CONTENT_TYPE_INVALID', `Invalid content_type: ${value}`, 400);
  }
  return base;
}

function contentTypeFromName(name: string | undefined): string | null {
  if (!name) return null;
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  return MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

export function resolveUploadContentType(
  override: string | undefined,
  file: ConnectorFileReference | undefined,
  destinationPath: string,
): string {
  return normalizeContentType(override)
    ?? normalizeContentType(file?.mime_type)
    ?? contentTypeFromName(file?.file_name)
    ?? contentTypeFromName(destinationPath)
    ?? 'application/octet-stream';
}

export function attachmentFileName(file: ConnectorFileReference, index: number): string {
  const rawName = file.file_name || `${file.file_id || `attachment-${index + 1}`}.bin`;
  const baseName = rawName.split(/[\\/]/).pop() || `attachment-${index + 1}.bin`;
  let safeName = baseName
    .normalize('NFKC')
    .replace(/[\x00-\x1f\x7f]+/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!safeName || safeName === '.' || safeName === '..') safeName = `attachment-${index + 1}.bin`;
  if (safeName.startsWith('.')) safeName = `file${safeName}`;
  if (safeName.length > 180) {
    const dot = safeName.lastIndexOf('.');
    const extension = dot > 0 && safeName.length - dot <= 16 ? safeName.slice(dot) : '';
    safeName = safeName.slice(0, 180 - extension.length) + extension;
  }
  return safeName;
}

export function taskAttachmentPaths(taskId: string, files: ConnectorFileReference[]): string[] {
  const used = new Set<string>();
  return files.map((file, index) => {
    const original = attachmentFileName(file, index);
    const dot = original.lastIndexOf('.');
    const stem = dot > 0 ? original.slice(0, dot) : original;
    const extension = dot > 0 ? original.slice(dot) : '';
    let name = original;
    let suffix = 2;
    while (used.has(name.toLowerCase())) {
      name = `${stem}-${suffix}${extension}`;
      suffix++;
    }
    used.add(name.toLowerCase());
    return `/tasks/${taskId}/attachments/${name}`;
  });
}

function apiErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const message = (payload as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

function storageRecordFromPayload(payload: unknown): StorageRecord | null {
  if (!payload || typeof payload !== 'object') return null;
  const envelope = payload as Record<string, unknown>;
  const candidate = envelope.data && typeof envelope.data === 'object'
    ? envelope.data as Record<string, unknown>
    : envelope;
  if (
    typeof candidate.path !== 'string'
    || typeof candidate.size_bytes !== 'number'
    || typeof candidate.content_type !== 'string'
    || typeof candidate.version !== 'number'
  ) return null;
  return {
    path: candidate.path,
    size_bytes: candidate.size_bytes,
    content_type: candidate.content_type,
    version: candidate.version,
  };
}

const defaultConnectorFileDownloader: ConnectorFileDownloader = (downloadUrl, maxBytes) =>
  safeFetch(downloadUrl, {
    allowedProtocols: ['https:'],
    maxBytes,
    maxRedirects: 3,
    timeoutMs: 30_000,
  });

export async function streamConnectorFileToUpload(
  fetcher: Fetcher,
  uploadUrl: string,
  file: ConnectorFileReference,
  contentType: string,
  downloadFile: ConnectorFileDownloader = defaultConnectorFileDownloader,
  maxBytes = MAX_CONNECTOR_FILE_BYTES,
): Promise<StorageRecord> {
  let relayUrl: URL;
  try {
    relayUrl = new URL(uploadUrl);
  } catch {
    throw new FileUploadError('UPLOAD_RELAY_INVALID', 'The upload relay returned an invalid URL.', 502);
  }
  if (relayUrl.protocol !== 'https:' || !relayUrl.pathname.startsWith('/v1/upload/')) {
    throw new FileUploadError('UPLOAD_RELAY_INVALID', 'The upload relay returned an unexpected target.', 502);
  }

  let source: Response;
  try {
    source = await downloadFile(file.download_url, Math.min(maxBytes, MAX_CONNECTOR_FILE_BYTES));
  } catch {
    throw new FileUploadError(
      'FILE_DOWNLOAD_FAILED',
      'The connector file could not be downloaded safely.',
      502,
    );
  }
  if (!source.ok) {
    throw new FileUploadError(
      'FILE_DOWNLOAD_FAILED',
      `The connector file could not be downloaded (HTTP ${source.status}).`,
      source.status,
    );
  }

  let uploadResponse: Response;
  try {
    uploadResponse = await fetcher.fetch(
      `https://api-internal${relayUrl.pathname}${relayUrl.search}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: source.body ?? new Uint8Array(0),
      },
    );
  } catch {
    throw new FileUploadError(
      'FS_UPLOAD_FAILED',
      'The file upload relay failed before storage confirmed the write.',
      502,
    );
  }
  const responseType = uploadResponse.headers.get('Content-Type') || '';
  const payload: unknown = responseType.includes('application/json')
    ? await uploadResponse.json().catch(() => null)
    : await uploadResponse.text().catch(() => '');
  if (!uploadResponse.ok) {
    throw new FileUploadError(
      'FS_UPLOAD_FAILED',
      apiErrorMessage(payload, `The file upload failed (HTTP ${uploadResponse.status}).`),
      uploadResponse.status,
      payload,
    );
  }

  const record = storageRecordFromPayload(payload);
  if (!record) {
    throw new FileUploadError(
      'FS_UPLOAD_BAD_RESPONSE',
      'The upload relay succeeded without returning a valid storage record.',
      502,
      payload,
    );
  }
  return record;
}

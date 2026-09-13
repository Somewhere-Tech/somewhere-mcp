export interface ConnectorFileReference {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export interface StorageRecord {
  path: string;
  size_bytes: number;
  content_type: string;
  version: number;
}

export type ConnectorFileDownloader = (
  downloadUrl: string,
  maxBytes: number,
) => Promise<Response>;

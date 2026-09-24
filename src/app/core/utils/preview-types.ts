import { S3ListItem } from '../models/models';

export type PreviewKind = 'image' | 'text' | 'pdf' | 'video' | 'audio';

export interface PreviewInfo {
  kind: PreviewKind;
  /** Content-Type the preview URL forces on the response, so objects stored as octet-stream still render. */
  mime: string;
}

const IMAGE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif'
};

const VIDEO: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg'
};

const AUDIO: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac'
};

// Always shown as source text (never rendered), so html/svg-as-text can't run anything.
const TEXT = new Set([
  'txt', 'md', 'log', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'ini', 'conf', 'config', 'cfg', 'env', 'toml',
  'properties', 'sh', 'bat', 'ps1', 'sql', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'html', 'htm', 'py',
  'java', 'cs', 'go', 'rb', 'php', 'c', 'cpp', 'h', 'rs', 'kt', 'swift', 'gitignore', 'dockerfile'
]);

/** Extension (or a bare name like "Dockerfile" / ".gitignore") -> how to preview it, or null if unsupported. */
export function getPreviewInfo(name: string): PreviewInfo | null {
  const base = name.split('/').pop()!.toLowerCase();
  const dot = base.lastIndexOf('.');
  const ext = dot === -1 ? base : base.slice(dot + 1);

  if (IMAGE[ext]) return { kind: 'image', mime: IMAGE[ext] };
  if (VIDEO[ext]) return { kind: 'video', mime: VIDEO[ext] };
  if (AUDIO[ext]) return { kind: 'audio', mime: AUDIO[ext] };
  if (ext === 'pdf') return { kind: 'pdf', mime: 'application/pdf' };
  if (TEXT.has(ext)) return { kind: 'text', mime: 'text/plain; charset=utf-8' };
  return null;
}

export function isPreviewable(item: S3ListItem): boolean {
  return item.type === 'file' && !!getPreviewInfo(item.name);
}

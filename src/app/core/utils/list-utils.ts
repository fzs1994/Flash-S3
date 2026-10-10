import { AppSettings, S3ListItem } from '../models/models';

export type SortKey = 'name' | 'ext' | 'size' | 'date' | 'class';

/** Lower-cased extension without the dot; '' for folders, extensionless files and dotfiles like ".env". */
export function extensionOf(item: S3ListItem): string {
  if (item.type === 'folder') return '';
  const dot = item.name.lastIndexOf('.');
  return dot > 0 ? item.name.slice(dot + 1).toLowerCase() : '';
}

/** Explorer-style: folders always group above files, then the chosen column, with name as the tiebreaker. */
export function sortItems(items: S3ListItem[], key: SortKey, dir: 'asc' | 'desc'): S3ListItem[] {
  const sign = dir === 'asc' ? 1 : -1;
  const byName = (a: S3ListItem, b: S3ListItem) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const value = (i: S3ListItem): string | number => {
    switch (key) {
      case 'ext':
        return extensionOf(i);
      case 'size':
        return i.size ?? -1;
      case 'date':
        return i.lastModified ? new Date(i.lastModified).getTime() : -1;
      case 'class':
        return i.storageClass ?? '';
      default:
        return '';
    }
  };
  return [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    if (key === 'name') return sign * byName(a, b);
    const va = value(a);
    const vb = value(b);
    const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
    return cmp !== 0 ? sign * cmp : byName(a, b);
  });
}

/** Dotfiles / dot-folders (".git", ".env") are what "hidden items" means in an S3 listing. */
export function isHiddenItem(item: S3ListItem): boolean {
  return item.name.startsWith('.');
}

export function withoutHidden(items: S3ListItem[], settings: AppSettings): S3ListItem[] {
  return settings.showHiddenItems ? items : items.filter((i) => !isHiddenItem(i));
}

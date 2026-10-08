import { CommonModule } from '@angular/common';
import { Component, EventEmitter, HostListener, Input, OnInit, Output, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ElectronService } from '../../core/services/electron.service';
import { DropdownComponent, DropdownOption } from '../dropdown/dropdown.component';

type Permission = 'READ' | 'WRITE' | 'READ_ACP' | 'WRITE_ACP' | 'FULL_CONTROL';

interface AclGrant {
  type: 'CanonicalUser' | 'Group' | 'AmazonCustomerByEmail';
  id: string;
  displayName: string;
  uri: string;
  email: string;
  permission: Permission;
}

/** One line in the editor: a grantee plus the set of individual permissions they hold (FULL_CONTROL is expanded). */
interface GranteeRow {
  type: AclGrant['type'];
  id: string;
  uri: string;
  email: string;
  label: string;
  sub: string;
  isOwner: boolean;
  perms: Set<Permission>;
}

const GROUP_ALL_USERS = 'http://acs.amazonaws.com/groups/global/AllUsers';
const GROUP_AUTH_USERS = 'http://acs.amazonaws.com/groups/global/AuthenticatedUsers';
const GROUP_LOG_DELIVERY = 'http://acs.amazonaws.com/groups/s3/LogDelivery';

const GROUP_LABELS: Record<string, string> = {
  [GROUP_ALL_USERS]: 'Everyone (public access)',
  [GROUP_AUTH_USERS]: 'Any authenticated AWS user',
  [GROUP_LOG_DELIVERY]: 'S3 Log Delivery group'
};

const CANNED_PRESETS = [
  { id: 'private', label: 'Private', hint: 'Owner only', icon: 'fi-sr-lock' },
  { id: 'authenticated-read', label: 'Authenticated read', hint: 'Any AWS account can read', icon: 'fi-sr-users' },
  { id: 'public-read', label: 'Public read', hint: 'Anyone on the internet can read', icon: 'fi-sr-globe' }
];

/**
 * ACL viewer/editor for a single object (when `objectKey` is set) or for a whole bucket.
 *
 * ACLs are S3's legacy permission model. Buckets using "Bucket owner enforced" object ownership (the default for new
 * buckets) reject ACL reads/writes entirely - that case is surfaced as a clear message instead of a raw SDK error.
 */
@Component({
  selector: 'app-acl-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, DropdownComponent],
  templateUrl: './acl-dialog.component.html',
  styleUrl: './acl-dialog.component.scss'
})
export class AclDialogComponent implements OnInit {
  @Input({ required: true }) connectionId!: string;
  @Input({ required: true }) bucket!: string;
  /** Object key; omit/null to edit the bucket's own ACL. */
  @Input() objectKey: string | null = null;
  @Output() closed = new EventEmitter<void>();

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly notSupported = signal(false);
  readonly saved = signal(false);

  readonly rows = signal<GranteeRow[]>([]);
  private owner = { id: '', displayName: '' };
  private snapshot = '';

  readonly presets = CANNED_PRESETS;
  readonly granteeTypeOptions: DropdownOption[] = [
    { value: 'all', label: 'Everyone (public)', icon: 'fi-sr-globe' },
    { value: 'auth', label: 'Any authenticated AWS user', icon: 'fi-sr-users' },
    { value: 'log', label: 'S3 Log Delivery group', icon: 'fi-sr-document' },
    { value: 'user', label: 'AWS account (canonical ID)', icon: 'fi-sr-user' }
  ];
  newGranteeType = 'all';
  newCanonicalId = '';

  get isBucket(): boolean {
    return !this.objectKey;
  }

  /** Permission columns that apply: WRITE only means something on a bucket. */
  get columns(): { perm: Permission; label: string; hint: string }[] {
    return this.isBucket
      ? [
          { perm: 'READ', label: 'List', hint: 'List objects in the bucket' },
          { perm: 'WRITE', label: 'Write', hint: 'Create, overwrite and delete objects' },
          { perm: 'READ_ACP', label: 'Read ACL', hint: 'View this ACL' },
          { perm: 'WRITE_ACP', label: 'Write ACL', hint: 'Change this ACL' }
        ]
      : [
          { perm: 'READ', label: 'Read', hint: 'Download the object' },
          { perm: 'READ_ACP', label: 'Read ACL', hint: 'View this ACL' },
          { perm: 'WRITE_ACP', label: 'Write ACL', hint: 'Change this ACL' }
        ];
  }

  readonly isPublic = computed(() => this.rows().some((r) => r.uri === GROUP_ALL_USERS && r.perms.size > 0));
  readonly dirty = computed(() => this.serialize(this.rows()) !== this.snapshot);

  /** Whether the ACL as last loaded from S3 already granted public access (so saving doesn't re-warn about it). */
  private loadedPublic = false;

  constructor(private electron: ElectronService) {}

  get title(): string {
    return this.isBucket ? this.bucket : (this.objectKey as string).split('/').filter(Boolean).pop() || (this.objectKey as string);
  }

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const acl = await this.electron.api.s3.getAcl(this.connectionId, this.bucket, this.objectKey);
      this.owner = acl.owner;
      const rows = this.groupGrants(acl.grants);
      this.rows.set(rows);
      this.snapshot = this.serialize(rows);
      this.loadedPublic = rows.some((r) => r.uri === GROUP_ALL_USERS && r.perms.size > 0);
    } catch (err: any) {
      this.handleError(err);
    } finally {
      this.loading.set(false);
    }
  }

  private groupGrants(grants: AclGrant[]): GranteeRow[] {
    const all = this.columns.map((c) => c.perm);
    const map = new Map<string, GranteeRow>();
    for (const g of grants) {
      const k = this.granteeKey(g);
      let row = map.get(k);
      if (!row) {
        row = {
          type: g.type,
          id: g.id,
          uri: g.uri,
          email: g.email,
          label: this.labelFor(g),
          sub: g.type === 'CanonicalUser' ? g.id : g.type === 'Group' ? g.uri : g.email,
          isOwner: g.type === 'CanonicalUser' && g.id === this.owner.id,
          perms: new Set<Permission>()
        };
        map.set(k, row);
      }
      if (g.permission === 'FULL_CONTROL') all.forEach((p) => row!.perms.add(p));
      else row.perms.add(g.permission);
    }
    // Owner first, then everyone else alphabetically.
    return Array.from(map.values()).sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || a.label.localeCompare(b.label));
  }

  private granteeKey(g: { type: string; id: string; uri: string; email: string }): string {
    return `${g.type}|${g.id}|${g.uri}|${g.email}`;
  }

  private labelFor(g: AclGrant): string {
    if (g.type === 'Group') return GROUP_LABELS[g.uri] || g.uri.split('/').pop() || g.uri;
    if (g.type === 'AmazonCustomerByEmail') return g.email;
    if (g.id === this.owner.id) return `${g.displayName || 'Owner'} (owner)`;
    return g.displayName || `${g.id.slice(0, 12)}…`;
  }

  private serialize(rows: GranteeRow[]): string {
    return JSON.stringify(
      rows
        .filter((r) => r.perms.size)
        .map((r) => [this.granteeKey(r), Array.from(r.perms).sort()])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    );
  }

  has(row: GranteeRow, perm: Permission): boolean {
    return row.perms.has(perm);
  }

  toggle(row: GranteeRow, perm: Permission): void {
    if (row.perms.has(perm)) row.perms.delete(perm);
    else row.perms.add(perm);
    this.rows.update((r) => [...r]);
    this.saved.set(false);
  }

  removeRow(row: GranteeRow): void {
    this.rows.update((r) => r.filter((x) => x !== row));
    this.saved.set(false);
  }

  addGrantee(): void {
    let row: GranteeRow;
    if (this.newGranteeType === 'user') {
      const id = this.newCanonicalId.trim();
      if (!id) {
        this.error.set('Enter the AWS account canonical user ID.');
        return;
      }
      row = { type: 'CanonicalUser', id, uri: '', email: '', label: `${id.slice(0, 12)}…`, sub: id, isOwner: false, perms: new Set<Permission>(['READ']) };
    } else {
      const uri = this.newGranteeType === 'all' ? GROUP_ALL_USERS : this.newGranteeType === 'auth' ? GROUP_AUTH_USERS : GROUP_LOG_DELIVERY;
      row = { type: 'Group', id: '', uri, email: '', label: GROUP_LABELS[uri], sub: uri, isOwner: false, perms: new Set<Permission>(['READ']) };
    }
    if (this.rows().some((r) => this.granteeKey(r) === this.granteeKey(row))) {
      this.error.set('That grantee is already in the list.');
      return;
    }
    this.error.set(null);
    this.newCanonicalId = '';
    this.rows.update((r) => [...r, row]);
    this.saved.set(false);
  }

  /** Collapses a row's permission set back into grants; a full set becomes a single FULL_CONTROL grant. */
  private toGrants(): AclGrant[] {
    const applicable = this.columns.map((c) => c.perm);
    const grants: AclGrant[] = [];
    for (const r of this.rows()) {
      if (!r.perms.size) continue;
      const base = { type: r.type, id: r.id, displayName: '', uri: r.uri, email: r.email };
      if (applicable.every((p) => r.perms.has(p))) grants.push({ ...base, permission: 'FULL_CONTROL' });
      else for (const p of applicable) if (r.perms.has(p)) grants.push({ ...base, permission: p });
    }
    return grants;
  }

  async save(): Promise<void> {
    if (this.isPublic() && !this.loadedPublic) {
      const ok = await this.electron.api.dialogs.confirm(
        'Make this public?',
        `This grants access to everyone on the internet for ${this.isBucket ? 'the bucket' : 'this object'}.`
      );
      if (!ok) return;
    }
    await this.run(() =>
      this.electron.api.s3.putAcl(this.connectionId, this.bucket, this.objectKey, { owner: this.owner, grants: this.toGrants() })
    );
  }

  async applyPreset(preset: { id: string; label: string }): Promise<void> {
    const ok = await this.electron.api.dialogs.confirm(
      `Apply "${preset.label}"?`,
      `This replaces every existing grant on this ${this.isBucket ? 'bucket' : 'object'}.`
    );
    if (!ok) return;
    await this.run(() => this.electron.api.s3.putAcl(this.connectionId, this.bucket, this.objectKey, { canned: preset.id }));
  }

  private async run(action: () => Promise<unknown>): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      await action();
      await this.load();
      this.saved.set(true);
    } catch (err: any) {
      this.handleError(err);
    } finally {
      this.saving.set(false);
    }
  }

  private handleError(err: any): void {
    const msg: string = err?.message || String(err);
    if (/AccessControlListNotSupported|does not allow ACLs|BucketOwnerEnforced/i.test(msg)) {
      this.notSupported.set(true);
      this.error.set(null);
    } else {
      this.error.set(msg);
    }
  }

  @HostListener('document:keydown.escape')
  close(): void {
    this.closed.emit();
  }
}

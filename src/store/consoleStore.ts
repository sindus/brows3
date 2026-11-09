'use client';

import { create } from 'zustand';

export interface ConsoleEntry {
  id: string;
  timestamp: number;
  command: string;
  status: 'pending' | 'success' | 'error';
  error?: string;
  durationMs?: number;
}

interface ConsoleState {
  entries: ConsoleEntry[];
  isOpen: boolean;
  toggle: () => void;
  setOpen: (open: boolean) => void;
  addEntry: (command: string) => string;
  resolveEntry: (id: string, status: 'success' | 'error', error?: string, durationMs?: number) => void;
  clear: () => void;
}

let nextEntryId = 0;

export const useConsoleStore = create<ConsoleState>((set) => ({
  entries: [],
  isOpen: false,
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
  setOpen: (open) => set({ isOpen: open }),
  addEntry: (command) => {
    const id = `cmd-${++nextEntryId}`;
    set((state) => ({
      entries: [...state.entries, {
        id,
        timestamp: Date.now(),
        command,
        status: 'pending' as const,
      }].slice(-500),
    }));
    return id;
  },
  resolveEntry: (id, status, error, durationMs) => set((state) => ({
    entries: state.entries.map((e) =>
      e.id === id ? { ...e, status, error, durationMs } : e
    ),
  })),
  clear: () => set({ entries: [] }),
}));

/**
 * Quotes a value for a POSIX shell, so a copied command never runs anything
 * hidden in an object key (spaces, quotes, `$(...)`, backticks...).
 */
export function shellQuote(value: unknown): string {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

const s3Uri = (bucket: unknown, key: unknown = '') => shellQuote(`s3://${bucket}/${key ?? ''}`);
/** Text for a trailing `#` comment: a newline would end it. */
const commentText = (value: unknown) => String(value ?? '').replace(/[\r\n]+/g, ' ');

// Commands that map to AWS CLI — everything else is internal and not shown
const AWS_COMMANDS = new Set([
  'list_buckets', 'list_buckets_with_regions', 'get_bucket_region',
  'create_bucket', 'delete_bucket', 'get_bucket_policy', 'put_bucket_policy',
  'list_objects', 'search_objects',
  'get_presigned_url', 'get_object_content', 'put_object_content', 'get_object_metadata',
  'put_object', 'get_object', 'delete_object', 'delete_objects', 'copy_object', 'move_object',
  'set_object_content_type', 'get_object_permissions', 'set_object_permissions',
  'queue_upload', 'queue_download', 'queue_folder_upload', 'queue_folder_download',
  'enqueue_thumbnails',
]);

export function toAwsCliCommand(cmd: string, args: Record<string, unknown> = {}): string | string[] | null {
  if (!AWS_COMMANDS.has(cmd)) return null;
  const q = shellQuote;
  const r = args?.bucketRegion ? ` --region ${q(args.bucketRegion)}` : '';

  switch (cmd) {
    case 'list_buckets':
    case 'list_buckets_with_regions':
      return 'aws s3 ls';

    case 'get_bucket_region':
      return `aws s3api get-bucket-location --bucket ${q(args.bucketName)}`;

    case 'create_bucket': {
      const region = args.region ? String(args.region) : '';
      let c = `aws s3api create-bucket --bucket ${q(args.bucketName)}`;
      if (region) c += ` --region ${q(region)}`;
      if (region && region !== 'us-east-1') c += ` --create-bucket-configuration ${q(`LocationConstraint=${region}`)}`;
      return c;
    }

    case 'delete_bucket':
      return `aws s3api delete-bucket --bucket ${q(args.bucketName)}${r}`;

    case 'get_bucket_policy':
      return `aws s3api get-bucket-policy --bucket ${q(args.bucketName)}${r}`;

    case 'put_bucket_policy':
      return `aws s3api put-bucket-policy --bucket ${q(args.bucketName)} --policy ${q(args.policy)}${r}`;

    case 'list_objects': {
      let c = `aws s3api list-objects-v2 --bucket ${q(args.bucketName)}`;
      if (args.prefix) c += ` --prefix ${q(args.prefix)}`;
      if (args.delimiter) c += ` --delimiter ${q(args.delimiter)}`;
      if (args.continuationToken) c += ` --continuation-token ${q(args.continuationToken)}`;
      return c + r;
    }

    case 'search_objects': {
      let c = `aws s3api list-objects-v2 --bucket ${q(args.bucketName)}`;
      if (args.prefix) c += ` --prefix ${q(args.prefix)}`;
      return c + r + (args.query ? ` # search: ${commentText(args.query)}` : '');
    }

    case 'get_presigned_url':
      return `aws s3 presign ${s3Uri(args.bucketName, args.key)} --expires-in ${q(args.expiresIn ?? 3600)}${r}`;

    case 'get_object_content':
      return `aws s3 cp ${s3Uri(args.bucketName, args.key)} -${r}`;

    case 'put_object_content':
      return `aws s3 cp - ${s3Uri(args.bucketName, args.key)}${r}`;

    case 'get_object_metadata':
      return `aws s3api head-object --bucket ${q(args.bucketName)} --key ${q(args.key)}${r}`;

    case 'put_object':
      return `aws s3 cp ${q(args.localPath ?? '<file>')} ${s3Uri(args.bucketName, args.key)}${r}`;

    case 'get_object':
      return `aws s3 cp ${s3Uri(args.bucketName, args.key)} ${q(args.localPath)}${r}`;

    case 'delete_object':
      return `aws s3 rm ${s3Uri(args.bucketName, args.key)}${r}`;

    case 'delete_objects': {
      const keys = (args.keys as string[] | undefined) ?? [];
      if (keys.length === 1) return `aws s3 rm ${s3Uri(args.bucketName, keys[0])}${r}`;
      const payload = JSON.stringify({ Objects: keys.map((key) => ({ Key: key })) });
      return `aws s3api delete-objects --bucket ${q(args.bucketName)} --delete ${q(payload)}${r}`;
    }

    case 'copy_object':
      return `aws s3 cp ${s3Uri(args.sourceBucket, args.sourceKey)} ${s3Uri(args.destinationBucket, args.destinationKey)}`;

    case 'move_object':
      return `aws s3 mv ${s3Uri(args.sourceBucket, args.sourceKey)} ${s3Uri(args.destinationBucket, args.destinationKey)}`;

    case 'set_object_content_type':
      return `aws s3api copy-object --bucket ${q(args.bucketName)} --key ${q(args.key)} --copy-source ${q(`${args.bucketName}/${args.key}`)} --content-type ${q(args.contentType)} --metadata-directive REPLACE${r}`;

    case 'get_object_permissions':
      return `aws s3api get-object-acl --bucket ${q(args.bucketName)} --key ${q(args.key)}${r}${args.isFolder ? ' # for each object under this prefix' : ''}`;

    case 'set_object_permissions':
      return `aws s3api put-object-acl --bucket ${q(args.bucketName)} --key ${q(args.key)} --acl ${q(args.cannedAcl)}${r}${args.isFolder ? ' # for each object under this prefix' : ''}`;

    case 'queue_upload':
      return `aws s3 cp ${q(args.localPath)} ${s3Uri(args.bucketName, args.key)}${r}`;

    case 'queue_download':
      return `aws s3 cp ${s3Uri(args.bucketName, args.key)} ${q(args.localPath)}${r}`;

    case 'queue_folder_upload':
      return `aws s3 sync ${q(args.localPath)} ${s3Uri(args.bucketName, args.prefix ?? '')}${r}`;

    case 'queue_folder_download':
      return `aws s3 sync ${s3Uri(args.bucketName, args.prefix ?? '')} ${q(args.localPath)}${r}`;

    case 'enqueue_thumbnails': {
      const count = ((args.items as unknown[] | undefined) ?? []).length;
      return `# thumbnails: reading ${count} object${count === 1 ? '' : 's'} (s3api get-object)`;
    }

    default:
      return null;
  }
}

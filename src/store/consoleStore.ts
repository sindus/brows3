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

export const useConsoleStore = create<ConsoleState>((set) => ({
  entries: [],
  isOpen: false,
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
  setOpen: (open) => set({ isOpen: open }),
  addEntry: (command) => {
    const id = Math.random().toString(36).substring(7);
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

// Commands that map to AWS CLI — everything else is internal and not shown
const AWS_COMMANDS = new Set([
  'list_buckets', 'list_buckets_with_regions', 'get_bucket_region',
  'list_objects', 'search_objects',
  'get_presigned_url', 'get_object_content', 'put_object_content', 'get_object_metadata',
  'put_object', 'get_object', 'delete_object', 'delete_objects', 'copy_object', 'move_object',
  'queue_upload', 'queue_download', 'queue_folder_upload', 'queue_folder_download',
  'start_thumbnail_generation', 'cancel_thumbnail_generation',
]);

export function toAwsCliCommand(cmd: string, args: Record<string, unknown> = {}): string | string[] | null {
  if (!AWS_COMMANDS.has(cmd)) return null;
  const r = args?.bucketRegion ? ` --region ${args.bucketRegion}` : '';

  switch (cmd) {
    case 'list_buckets':
    case 'list_buckets_with_regions':
      return 'aws s3 ls';

    case 'get_bucket_region':
      return `aws s3api get-bucket-location --bucket ${args.bucketName}`;

    case 'list_objects': {
      let c = `aws s3api list-objects-v2 --bucket ${args.bucketName}`;
      if (args.prefix) c += ` --prefix "${args.prefix}"`;
      if (args.delimiter) c += ` --delimiter "${args.delimiter}"`;
      if (args.continuationToken) c += ` --starting-token ${args.continuationToken}`;
      return c + r;
    }

    case 'search_objects': {
      let c = `aws s3api list-objects-v2 --bucket ${args.bucketName}`;
      if (args.prefix) c += ` --prefix "${args.prefix}"`;
      return c + r + (args.query ? ` # search: "${args.query}"` : '');
    }

    case 'get_presigned_url':
      return `aws s3 presign s3://${args.bucketName}/${args.key} --expires-in ${args.expiresIn ?? 3600}${r}`;

    case 'get_object_content':
      return `aws s3 cp s3://${args.bucketName}/${args.key} -${r}`;

    case 'put_object_content':
      return `aws s3 cp - s3://${args.bucketName}/${args.key}${r}`;

    case 'get_object_metadata':
      return `aws s3api head-object --bucket ${args.bucketName} --key "${args.key}"${r}`;

    case 'put_object':
      return `aws s3 cp "${args.localPath ?? '<file>'}" s3://${args.bucketName}/${args.key}${r}`;

    case 'get_object':
      return `aws s3 cp s3://${args.bucketName}/${args.key} "${args.localPath}"${r}`;

    case 'delete_object':
      return `aws s3 rm s3://${args.bucketName}/${args.key}${r}`;

    case 'delete_objects': {
      const keys = (args.keys as string[] | undefined) ?? [];
      if (keys.length === 1) return `aws s3 rm s3://${args.bucketName}/${keys[0]}${r}`;
      const objects = keys.map((k: string) => `{"Key":"${k}"}`).join(',');
      return `aws s3api delete-objects --bucket ${args.bucketName} --delete '{"Objects":[${objects}]}'${r}`;
    }

    case 'copy_object':
      return `aws s3 cp s3://${args.sourceBucket}/${args.sourceKey} s3://${args.destinationBucket}/${args.destinationKey}`;

    case 'move_object':
      return `aws s3 mv s3://${args.sourceBucket}/${args.sourceKey} s3://${args.destinationBucket}/${args.destinationKey}`;

    case 'queue_upload':
      return `aws s3 cp "${args.localPath}" s3://${args.bucketName}/${args.key}${r}`;

    case 'queue_download':
      return `aws s3 cp s3://${args.bucketName}/${args.key} "${args.localPath}"${r}`;

    case 'queue_folder_upload':
      return `aws s3 sync "${args.localPath}" s3://${args.bucketName}/${args.prefix ?? ''}${r}`;

    case 'queue_folder_download':
      return `aws s3 sync s3://${args.bucketName}/${args.prefix ?? ''} "${args.localPath}"${r}`;

    case 'start_thumbnail_generation': {
      const keys = (args.keys as string[]) ?? [];
      const r2 = args.bucketRegion ? ` --region ${args.bucketRegion}` : '';
      return keys.map((k) => `aws s3 presign s3://${args.bucket}/${k} --expires-in 300${r2}`);
    }

    case 'cancel_thumbnail_generation':
      return '# thumbnail generation cancelled';

    default:
      return null;
  }
}

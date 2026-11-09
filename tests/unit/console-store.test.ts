import { expect, test } from 'vitest';
import { shellQuote, toAwsCliCommand, useConsoleStore } from '@/store/consoleStore';

test('plain values stay readable and others are single-quoted', () => {
  expect(shellQuote('photos/2026/a.jpg')).toBe('photos/2026/a.jpg');
  expect(shellQuote('my file.jpg')).toBe("'my file.jpg'");
  expect(shellQuote("it's")).toBe("'it'\\''s'");
});

test('object keys cannot inject shell commands', () => {
  const command = toAwsCliCommand('delete_object', { bucketName: 'b', key: 'x $(rm -rf ~) `id`; y' }) as string;
  expect(command).toBe("aws s3 rm 's3://b/x $(rm -rf ~) `id`; y'");
  const batch = toAwsCliCommand('delete_objects', { bucketName: 'b', keys: ["a'b", 'c'] }) as string;
  expect(batch).toBe(`aws s3api delete-objects --bucket b --delete '{"Objects":[{"Key":"a'\\''b"},{"Key":"c"}]}'`);
});

test('pagination uses the S3 continuation token option', () => {
  expect(toAwsCliCommand('list_objects', { bucketName: 'b', prefix: 'a/', delimiter: '/', continuationToken: 'tok', bucketRegion: 'eu-west-3' }))
    .toBe('aws s3api list-objects-v2 --bucket b --prefix a/ --delimiter / --continuation-token tok --region eu-west-3');
});

test('a search query cannot leave its comment', () => {
  expect(toAwsCliCommand('search_objects', { bucketName: 'b', query: 'x\nrm -rf ~' })).toBe('aws s3api list-objects-v2 --bucket b # search: x rm -rf ~');
});

test('bucket, permission and content type actions have an equivalent', () => {
  expect(toAwsCliCommand('create_bucket', { bucketName: 'b', region: 'eu-west-3' }))
    .toBe('aws s3api create-bucket --bucket b --region eu-west-3 --create-bucket-configuration LocationConstraint=eu-west-3');
  expect(toAwsCliCommand('set_object_permissions', { bucketName: 'b', key: 'k', cannedAcl: 'private' }))
    .toBe('aws s3api put-object-acl --bucket b --key k --acl private');
  expect(toAwsCliCommand('set_object_content_type', { bucketName: 'b', key: 'k', contentType: 'image/png' }))
    .toBe('aws s3api copy-object --bucket b --key k --copy-source b/k --content-type image/png --metadata-directive REPLACE');
});

test('thumbnail batches are summarised on one line', () => {
  expect(toAwsCliCommand('enqueue_thumbnails', { items: [{}, {}, {}] })).toBe('# thumbnails: reading 3 objects (s3api get-object)');
  expect(toAwsCliCommand('start_thumbnail_generation', {})).toBeNull();
});

test('entry ids are unique', () => {
  const { addEntry } = useConsoleStore.getState();
  const ids = new Set(Array.from({ length: 1000 }, () => addEntry('aws s3 ls')));
  expect(ids.size).toBe(1000);
});

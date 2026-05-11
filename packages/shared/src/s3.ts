import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

function createS3Client(): S3Client {
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? 'ru-1',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? '',
      secretAccessKey: process.env.S3_SECRET_KEY ?? '',
    },
    forcePathStyle: true,
  });
}

let _client: S3Client | null = null;
function getClient(): S3Client {
  if (!_client) _client = createS3Client();
  return _client;
}

export const S3_BUCKET = process.env.S3_BUCKET ?? '';
export const S3_PUBLIC_URL = process.env.S3_PUBLIC_URL ?? '';

export async function uploadToS3(
  key: string,
  body: Buffer,
  contentType: string
): Promise<string> {
  const client = getClient();
  const bucket = S3_BUCKET;
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ACL: 'public-read',
  }));
  const base = S3_PUBLIC_URL || `${process.env.S3_ENDPOINT}/${bucket}`;
  return `${base}/${key}`;
}

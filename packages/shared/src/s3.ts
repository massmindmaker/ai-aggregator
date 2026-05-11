import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

function getEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`S3 config error: ${name} env var is required`);
  return val;
}

function createS3Client(): S3Client {
  return new S3Client({
    endpoint: getEnv('S3_ENDPOINT'),
    region: process.env.S3_REGION ?? 'ru-1',
    credentials: {
      accessKeyId: getEnv('S3_ACCESS_KEY'),
      secretAccessKey: getEnv('S3_SECRET_KEY'),
    },
    forcePathStyle: true,
  });
}

let _client: S3Client | null = null;
function getClient(): S3Client {
  if (!_client) _client = createS3Client();
  return _client;
}

export interface UploadOptions {
  /** Если true — ACL=private (по умолчанию public-read для совместимости). */
  private?: boolean;
}

export async function uploadToS3(
  key: string,
  body: Buffer,
  contentType: string,
  options: UploadOptions = {}
): Promise<string> {
  const bucket = getEnv('S3_BUCKET');
  const endpoint = getEnv('S3_ENDPOINT');
  const client = getClient();

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ACL: options.private ? 'private' : 'public-read',
  }));

  const publicUrl = process.env.S3_PUBLIC_URL;
  const base = publicUrl
    ? publicUrl.replace(/\/$/, '')
    : `${endpoint.replace(/\/$/, '')}/${bucket}`;
  const normalizedKey = key.replace(/^\//, '');
  return `${base}/${normalizedKey}`;
}

/**
 * Сгенерировать pre-signed URL для скачивания private S3-объекта.
 * Используется для submission файлов конкурсантов и других приватных артефактов.
 */
export async function getSignedDownloadUrl(
  key: string,
  expiresInSec = 3600
): Promise<string> {
  const client = getClient();
  const bucket = getEnv('S3_BUCKET');
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: expiresInSec }
  );
}

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

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

export async function uploadToS3(
  key: string,
  body: Buffer,
  contentType: string
): Promise<string> {
  const bucket = getEnv('S3_BUCKET');
  const endpoint = getEnv('S3_ENDPOINT');
  const client = getClient();

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ACL: 'public-read',
  }));

  const publicUrl = process.env.S3_PUBLIC_URL;
  const base = publicUrl
    ? publicUrl.replace(/\/$/, '')
    : `${endpoint.replace(/\/$/, '')}/${bucket}`;
  const normalizedKey = key.replace(/^\//, '');
  return `${base}/${normalizedKey}`;
}

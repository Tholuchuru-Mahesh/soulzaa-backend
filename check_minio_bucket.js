const { S3Client, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');

async function checkBucket() {
  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: 'http://127.0.0.1:9000',
    forcePathStyle: true,
    credentials: {
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin'
    }
  });

  const bucket = 'soulzaa-media';
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`Bucket '${bucket}' exists and is accessible!`);
  } catch (err) {
    console.log(`Bucket '${bucket}' not found or error. Creating it...`);
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      console.log(`Bucket '${bucket}' created successfully!`);
    } catch (createErr) {
      console.error('Failed to create bucket:', createErr);
    }
  }
}

checkBucket();

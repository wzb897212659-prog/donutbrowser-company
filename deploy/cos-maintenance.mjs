import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
  DeleteObjectCommand,
  GetBucketAclCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const [operation, firstArg, secondArg] = process.argv.slice(2);
const bucket = process.env.COS_BUCKET;
const endpoint = process.env.COS_S3_ENDPOINT;
const region = process.env.COS_REGION;
if (!bucket || !endpoint || !region) throw new Error("COS environment is incomplete");

const client = new S3Client({ endpoint, region, forcePathStyle: false });

if (operation === "configure") {
  client.middlewareStack.add(
    (next) => async (args) => {
      const request = args.request;
      if (request?.body) {
        const body =
          typeof request.body === "string"
            ? Buffer.from(request.body)
            : Buffer.from(request.body);
        request.headers["content-md5"] = createHash("md5")
          .update(body)
          .digest("base64");
      }
      return next(args);
    },
    { step: "build", name: "cosContentMd5", priority: "low" },
  );
  await client.send(
    new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  );
  await client.send(
    new PutBucketEncryptionCommand({
      Bucket: bucket,
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
      },
    }),
  );
  const rules = [
    {
      ID: "profile-history-30-days",
      Status: "Enabled",
      Filter: { Prefix: "company/profiles/" },
      NoncurrentVersionExpiration: { NoncurrentDays: 30 },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
    },
    {
      ID: "database-backups-30-days",
      Status: "Enabled",
      Filter: { Prefix: "database-backups/" },
      Expiration: { Days: 30 },
      NoncurrentVersionExpiration: { NoncurrentDays: 30 },
    },
  ];
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: { Rules: rules },
    }),
  );
  const [versioning, encryption, lifecycle, acl] = await Promise.all([
    client.send(new GetBucketVersioningCommand({ Bucket: bucket })),
    client.send(new GetBucketEncryptionCommand({ Bucket: bucket })),
    client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })),
    client.send(new GetBucketAclCommand({ Bucket: bucket })),
  ]);
  const publicGrant = (acl.Grants ?? []).some((grant) =>
    /AllUsers|AuthenticatedUsers/i.test(grant.Grantee?.URI ?? ""),
  );
  if (publicGrant) throw new Error("Bucket ACL contains a public group grant");
  if (versioning.Status !== "Enabled") throw new Error("Bucket versioning is not enabled");
  if (!(encryption.ServerSideEncryptionConfiguration?.Rules?.length > 0)) {
    throw new Error("Bucket encryption is not configured");
  }
  if ((lifecycle.Rules?.length ?? 0) !== 2) throw new Error("Lifecycle rule count mismatch");
  console.log("COS_CONFIG_VERIFIED versioning=enabled encryption=enabled lifecycle_rules=2 acl=private");
} else if (operation === "upload-postgres-backup") {
  if (!firstArg || !secondArg) throw new Error("Usage: upload-postgres-backup <file> <key>");
  const local = await readFile(firstArg);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: secondArg,
      Body: local,
      ServerSideEncryption: "AES256",
      ContentType: "application/gzip",
    }),
  );
  const remote = await client.send(new GetObjectCommand({ Bucket: bucket, Key: secondArg }));
  const downloaded = Buffer.from(await remote.Body.transformToByteArray());
  const localHash = createHash("sha256").update(local).digest("hex");
  const remoteHash = createHash("sha256").update(downloaded).digest("hex");
  if (localHash !== remoteHash) throw new Error("Uploaded backup hash mismatch");
  const sql = gunzipSync(downloaded);
  if (!sql.subarray(0, 64).toString("utf8").includes("PostgreSQL database dump")) {
    throw new Error("Uploaded backup is not a valid PostgreSQL plain-text dump");
  }
  console.log(`BACKUP_VERIFIED bytes=${downloaded.length}`);
} else if (operation === "delete-prefix") {
  if (!firstArg) throw new Error("Usage: delete-prefix <prefix>");
  let continuationToken;
  let deleted = 0;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: firstArg,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (!object.Key) continue;
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
      deleted += 1;
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  console.log(`PREFIX_PURGED objects=${deleted}`);
} else {
  throw new Error(`Unknown COS maintenance operation: ${operation ?? "<missing>"}`);
}

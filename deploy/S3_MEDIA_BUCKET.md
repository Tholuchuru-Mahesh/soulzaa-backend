# Media bucket: `soulzaaa-media-prod` (eu-north-1)

How the media bucket is meant to be locked down, and why. Read this before
widening anything — the app's privacy model depends on the prefix split below.

## The prefix split

One bucket holds two kinds of object, and they must be served differently.

| Prefix | Public? | Why |
|---|---|---|
| `profile-images/` | **yes** | Avatars/covers. Shown to anyone who can see the user. |
| `room-backgrounds/` | **yes** | Audio/video room display pictures. Shown on public discovery lists. |
| `gift-assets/` | **yes** | Static catalogue art. Identical for every user. |
| `chat-images/`, `chat-voice/`, `chat-videos/`, `chat-files/` | **no** | Direct-message media. Private to the conversation. |
| `thumbnails/` | **no** | Mixed provenance — `MediaService` derives thumbnail keys by swapping *any* category prefix for this one, so chat thumbnails live here next to avatar ones. |
| `videos/`, `audio-assets/` | **no** | Not currently served publicly; private until someone decides otherwise. |

The application mirrors this table in
`src/infra/storage/media-url.resolver.ts` (`PUBLICLY_SERVABLE_PREFIXES`), which
is an **allowlist**: a category added later is presigned until it is explicitly
listed. Keep the two in lockstep.

- Prefix public in the app but not in S3 → users get **403s**.
- Prefix public in S3 but not in the app → merely a wasted signature. Harmless.

So when they drift, drift in that second direction.

## Why not just make the whole bucket public

`MediaUrlResolver` is shared infra — profiles, user search **and chat
attachments** all resolve keys through it. Before the prefix allowlist, setting
`MEDIA_PUBLIC_BASE_URL` turned every DM image, voice note and file into a
permanent unsigned URL. A presigned URL says *"this participant, for the next
fifteen minutes"*; a public one says *"anybody, forever"*. Those are not
interchangeable, and the difference is invisible at the call site — which is why
the decision is made centrally, by key prefix.

## Applying the policy

`deploy/s3-bucket-policy.json` holds the policy. It grants anonymous
`s3:GetObject` on the three public prefixes and nothing else, and denies all
plaintext HTTP.

```sh
aws s3api put-bucket-policy \
  --bucket soulzaaa-media-prod \
  --region eu-north-1 \
  --policy file://deploy/s3-bucket-policy.json
```

Public *policies* additionally require Block Public Access to permit them. Leave
the two ACL controls on — the app never sets object ACLs, so nothing needs them:

```sh
aws s3api put-public-access-block \
  --bucket soulzaaa-media-prod --region eu-north-1 \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false
```

## Verifying

A public asset must load unsigned, and a chat object must not:

```sh
# expect 200
curl -sI https://soulzaaa-media-prod.s3.eu-north-1.amazonaws.com/room-backgrounds/<userId>/<uuid>.jpg | head -1

# expect 403 — if this returns 200, private DM media is exposed
curl -sI https://soulzaaa-media-prod.s3.eu-north-1.amazonaws.com/chat-images/<userId>/<uuid>.jpg | head -1

# expect 403 — the bucket must never be listable
curl -sI https://soulzaaa-media-prod.s3.eu-north-1.amazonaws.com/ | head -1
```

## Further restrictions worth considering

Not applied here, each a deliberate trade-off:

- **Front with CloudFront + Origin Access Control**, then remove the public
  policy entirely. The bucket goes fully private, CloudFront becomes the only
  reader, and `MEDIA_PUBLIC_BASE_URL` points at the distribution. Buys caching at
  the edge, a WAF attach point, and per-object cost control. This is the natural
  next step if media egress grows.
- **Lifecycle rules**: expire orphaned uploads (objects confirmed but never
  attached to a row), and transition cold chat media to Infrequent Access.
- **`aws:Referer` / `aws:SourceIp` conditions**: cheap hotlink deterrence, but
  trivially spoofed and it breaks native mobile clients. Prefer CloudFront.
- **Object Ownership = BucketOwnerEnforced**: disables ACLs bucket-wide so
  permissions can only ever come from this policy. The app already never sets
  ACLs, so this is free hardening.
- **Server-side encryption (SSE-S3 or SSE-KMS)** as a bucket default, plus a
  `Deny` on `s3:PutObject` without encryption headers.
- **Access logging / CloudTrail data events** on the chat prefixes, so a leak
  would be detectable after the fact rather than hypothetical.

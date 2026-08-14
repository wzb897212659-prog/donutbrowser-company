#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
read_env_value() {
  sed -n "s/^$1=//p" ./.env.production | tail -n 1
}
COS_SECRET_ID=$(read_env_value COS_SECRET_ID)
COS_SECRET_KEY=$(read_env_value COS_SECRET_KEY)
COS_REGION=$(read_env_value COS_REGION)
COS_BUCKET=$(read_env_value COS_BUCKET)
COS_S3_ENDPOINT=$(read_env_value COS_S3_ENDPOINT)

aws_env_file=$(mktemp /tmp/sanhe-donut-aws.XXXXXX)
trap 'rm -f "$aws_env_file"' EXIT
chmod 0600 "$aws_env_file"
printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\nAWS_DEFAULT_REGION=%s\n' \
  "$COS_SECRET_ID" "$COS_SECRET_KEY" "$COS_REGION" > "$aws_env_file"
printf 'COS_REGION=%s\nCOS_BUCKET=%s\nCOS_S3_ENDPOINT=%s\n' \
  "$COS_REGION" "$COS_BUCKET" "$COS_S3_ENDPOINT" >> "$aws_env_file"

docker run --rm --user 0:0 \
  --env-file "$aws_env_file" \
  -v "$PWD/cos-maintenance.mjs:/app/cos-maintenance.mjs:ro" \
  deploy-donut-sync:latest node /app/cos-maintenance.mjs configure

#!/usr/bin/env bash
set -euo pipefail

install_dir=/opt/sanhe-donut
backup_dir=/var/backups/sanhe-donut
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_file="$backup_dir/donut-control-$stamp.sql.gz"

install -d -m 0700 "$backup_dir"
cd "$install_dir/deploy"
docker compose --env-file .env.production exec -T postgres \
  pg_dump -U donut -d donut_control | gzip -9 > "$backup_file"

read_env_value() {
  sed -n "s/^$1=//p" ./.env.production | tail -n 1
}
COS_SECRET_ID=$(read_env_value COS_SECRET_ID)
COS_SECRET_KEY=$(read_env_value COS_SECRET_KEY)
COS_REGION=$(read_env_value COS_REGION)
COS_BUCKET=$(read_env_value COS_BUCKET)
COS_S3_ENDPOINT=$(read_env_value COS_S3_ENDPOINT)
if [[ -z "$COS_SECRET_ID" || -z "$COS_SECRET_KEY" || -z "$COS_BUCKET" ]]; then
  echo "COS configuration is incomplete" >&2
  exit 1
fi

# Keep permanent COS credentials out of process arguments and `docker ps`.
# Docker reads this root-only file and injects the variables into the short-
# lived CLI container without expanding their values in the command line.
aws_env_file=$(mktemp /tmp/sanhe-donut-aws.XXXXXX)
trap 'rm -f "$aws_env_file"' EXIT
chmod 0600 "$aws_env_file"
printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\nAWS_DEFAULT_REGION=%s\n' \
  "$COS_SECRET_ID" "$COS_SECRET_KEY" "$COS_REGION" > "$aws_env_file"
printf 'COS_REGION=%s\nCOS_BUCKET=%s\nCOS_S3_ENDPOINT=%s\n' \
  "$COS_REGION" "$COS_BUCKET" "$COS_S3_ENDPOINT" >> "$aws_env_file"

cos_tool=(docker run --rm --user 0:0 \
  --env-file "$aws_env_file" \
  -v "$backup_dir:/backup:ro" \
  -v "$PWD/cos-maintenance.mjs:/app/cos-maintenance.mjs:ro" \
  deploy-donut-sync:latest node /app/cos-maintenance.mjs)

"${cos_tool[@]}" upload-postgres-backup "/backup/$(basename "$backup_file")" \
  "database-backups/$(basename "$backup_file")"

# Purge the current objects for profiles whose 30-day soft-delete window has
# elapsed. COS versioning keeps the previous object versions for the lifecycle
# window, so an interrupted purge cannot expose a partially restored profile.
mapfile -t expired_profiles < <(
  docker compose --env-file .env.production exec -T postgres \
    psql -U donut -d donut_control -Atc \
    "SELECT id FROM profiles WHERE deleted_at < now() - interval '30 days' ORDER BY id"
)
for profile_id in "${expired_profiles[@]}"; do
  "${cos_tool[@]}" delete-prefix "company/profiles/$profile_id/"
  docker compose --env-file .env.production exec -T postgres \
    psql -U donut -d donut_control -v ON_ERROR_STOP=1 -c \
    "DELETE FROM profiles WHERE id = '$profile_id' AND deleted_at < now() - interval '30 days'"
done

find "$backup_dir" -type f -name 'donut-control-*.sql.gz' -mtime +30 -delete

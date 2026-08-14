#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
umask 077
if [[ -e .env.production ]]; then
  echo ".env.production already exists; refusing to overwrite it." >&2
  exit 1
fi

private_key=$(mktemp)
public_key=$(mktemp)
trap 'rm -f "$private_key" "$public_key"' EXIT
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$private_key" >/dev/null 2>&1
openssl pkey -in "$private_key" -pubout -out "$public_key" >/dev/null 2>&1

postgres_password=$(openssl rand -hex 32)
internal_key=$(openssl rand -hex 32)
bootstrap_password=$(openssl rand -base64 24 | tr -d '\r\n')
private_env=$(awk '{printf "%s\\n", $0}' "$private_key")
public_env=$(awk '{printf "%s\\n", $0}' "$public_key")

{
  printf 'POSTGRES_PASSWORD=%s\n' "$postgres_password"
  printf 'INTERNAL_API_KEY=%s\n' "$internal_key"
  printf 'JWT_PRIVATE_KEY=%s\n' "$private_env"
  printf 'JWT_PUBLIC_KEY=%s\n' "$public_env"
  printf 'BOOTSTRAP_SUPERADMIN_USERNAME=superadmin\n'
  printf 'BOOTSTRAP_SUPERADMIN_PASSWORD=%s\n' "$bootstrap_password"
  printf 'COS_S3_ENDPOINT=https://cos.ap-guangzhou.myqcloud.com\n'
  printf 'COS_REGION=ap-guangzhou\n'
  printf 'COS_SECRET_ID=REPLACE_WITH_CAM_SECRET_ID\n'
  printf 'COS_SECRET_KEY=REPLACE_WITH_CAM_SECRET_KEY\n'
  printf 'COS_BUCKET=REPLACE_WITH_PRIVATE_BUCKET_NAME_APPID\n'
} > .env.production
chmod 0600 .env.production

{
  printf '管理入口: https://browser.sanheqiyun.xyz/admin/\n'
  printf '初始超级管理员用户名: superadmin\n'
  printf '初始超级管理员密码: %s\n' "$bootstrap_password"
  printf '创建其他超级管理员后，请在服务器 .env.production 中清空初始密码并重启 control-api。\n'
} > ../initial-admin.txt
chmod 0600 ../initial-admin.txt

echo "Generated production secrets and initial-admin.txt. COS values still require configuration."

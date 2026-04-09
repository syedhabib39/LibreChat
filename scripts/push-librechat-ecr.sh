#!/usr/bin/env bash
# Build LibreChat from the repo root Dockerfile and push to ECR.
#
# Usage:
#   ./scripts/push-librechat-ecr.sh <tag>
# Example:
#   ./scripts/push-librechat-ecr.sh admin-ui
#
# Optional environment overrides:
#   AWS_REGION       (default: us-east-1)
#   AWS_ACCOUNT_ID   (default: 582763096612)
#   ECR_REPO         (default: dbaas-ss-chat/librechat-dev)
#   AWS_PROFILE      (passed through to aws CLI if set)
#   DOCKERFILE       (default: Dockerfile)

set -euo pipefail

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  echo "Usage: $0 <image-tag>" >&2
  echo "Example: $0 admin-ui" >&2
  exit 1
fi

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-582763096612}"
ECR_REPO="${ECR_REPO:-dbaas-ss-chat/librechat-dev}"
DOCKERFILE="${DOCKERFILE:-Dockerfile}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ECR_HOST="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE_URI="${ECR_HOST}/${ECR_REPO}"

AWS_CLI=(aws)
if [[ -n "${AWS_PROFILE:-}" ]]; then
  AWS_CLI=(aws --profile "$AWS_PROFILE")
fi

echo "ECR repository: ${IMAGE_URI}"
echo "Tag:            ${TAG}"
echo "Build context:  ${REPO_ROOT}"
echo "Dockerfile:     ${DOCKERFILE}"
echo

echo "Logging in to ECR (${ECR_HOST})..."
"${AWS_CLI[@]}" ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "$ECR_HOST"

echo "Building image..."
docker build -f "$DOCKERFILE" -t "${IMAGE_URI}:${TAG}" .

echo "Pushing ${IMAGE_URI}:${TAG}..."
docker push "${IMAGE_URI}:${TAG}"

echo
echo "Done: ${IMAGE_URI}:${TAG}"

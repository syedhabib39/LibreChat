#!/usr/bin/env bash
# Build LibreChat from the repo root Dockerfile and push to ECR.
#
# Builds for linux/amd64 by default so images run on typical EKS x86_64 nodes.
# (Images built on Apple Silicon without --platform are often arm64 → kubelet exit 255 on amd64 workers.)
#
# Usage:
#   ./scripts/push-librechat-ecr.sh [--no-cache] <tag>
# Example:
#   ./scripts/push-librechat-ecr.sh admin-ui
#   ./scripts/push-librechat-ecr.sh --no-cache admin-ui   # fresh build, no BuildKit cache
#
# Optional environment overrides:
#   AWS_REGION         (default: us-east-1)
#   AWS_ACCOUNT_ID     (default: 582763096612)
#   ECR_REPO           (default: dbaas-ss-chat/librechat-dev)
#   AWS_PROFILE        (passed through to aws CLI if set)
#   DOCKERFILE         (default: Dockerfile)
#   PLATFORMS          (default: linux/amd64) — comma-separated for multi-arch, e.g. linux/amd64,linux/arm64
#   BUILDX_BUILDER     (optional) — docker buildx --builder name
#   VERIFY_MANIFEST=1  — after push, run imagetools inspect to print platform list
#   NO_CACHE=1         — same as --no-cache (no BuildKit layer cache)

set -euo pipefail

NO_CACHE_BUILD=0
if [[ "${NO_CACHE:-}" == "1" ]]; then
  NO_CACHE_BUILD=1
fi

TAG=""
for arg in "$@"; do
  case "$arg" in
    --no-cache)
      NO_CACHE_BUILD=1
      ;;
    *)
      if [[ -n "$TAG" ]]; then
        echo "error: unexpected extra argument: $arg (only one image tag allowed)" >&2
        exit 1
      fi
      TAG="$arg"
      ;;
  esac
done

if [[ -z "$TAG" ]]; then
  echo "Usage: $0 [--no-cache] <image-tag>" >&2
  echo "Example: $0 admin-ui" >&2
  echo "         $0 --no-cache admin-ui" >&2
  exit 1
fi

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-582763096612}"
ECR_REPO="${ECR_REPO:-dbaas-ss-chat/librechat-dev}"
DOCKERFILE="${DOCKERFILE:-Dockerfile}"
PLATFORMS="${PLATFORMS:-linux/amd64}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ECR_HOST="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE_URI="${ECR_HOST}/${ECR_REPO}"

AWS_CLI=(aws)
if [[ -n "${AWS_PROFILE:-}" ]]; then
  AWS_CLI=(aws --profile "$AWS_PROFILE")
fi

BUILDX_ARGS=(buildx build)
if [[ -n "${BUILDX_BUILDER:-}" ]]; then
  BUILDX_ARGS+=(--builder "$BUILDX_BUILDER")
fi

echo "ECR repository: ${IMAGE_URI}"
echo "Tag:            ${TAG}"
echo "Platforms:      ${PLATFORMS}"
echo "Build context:  ${REPO_ROOT}"
echo "Dockerfile:     ${DOCKERFILE}"
if [[ "$NO_CACHE_BUILD" -eq 1 ]]; then
  echo "Docker cache:     disabled (--no-cache)"
else
  echo "Docker cache:     enabled (default)"
fi
echo

if ! docker buildx version >/dev/null 2>&1; then
  echo "error: docker buildx is required (install Docker Buildx or use Docker Desktop)." >&2
  exit 1
fi

echo "Logging in to ECR (${ECR_HOST})..."
"${AWS_CLI[@]}" ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "$ECR_HOST"

echo "Ensuring Buildx builder is ready..."
if [[ -n "${BUILDX_BUILDER:-}" ]]; then
  docker buildx inspect "$BUILDX_BUILDER" --bootstrap >/dev/null
else
  docker buildx inspect --bootstrap >/dev/null
fi

echo "Building and pushing (${PLATFORMS})..."
BUILDX_EXTRA=()
if [[ "$NO_CACHE_BUILD" -eq 1 ]]; then
  BUILDX_EXTRA+=(--no-cache)
fi

docker "${BUILDX_ARGS[@]}" \
  --platform "$PLATFORMS" \
  -f "$DOCKERFILE" \
  -t "${IMAGE_URI}:${TAG}" \
  "${BUILDX_EXTRA[@]}" \
  --push \
  .

echo
echo "Done: ${IMAGE_URI}:${TAG}"

if [[ "${VERIFY_MANIFEST:-}" == "1" ]]; then
  echo
  echo "Manifest / platforms (docker buildx imagetools inspect):"
  docker buildx imagetools inspect "${IMAGE_URI}:${TAG}" || true
fi

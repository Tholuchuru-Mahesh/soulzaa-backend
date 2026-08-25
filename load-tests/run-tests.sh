#!/bin/bash

# run-tests.sh
# Usage: ./run-tests.sh <test-type> [environment]
# Example: ./run-tests.sh smoke staging

TYPE=$1
ENV=$2

if [ -z "$TYPE" ]; then
  echo "Usage: ./run-tests.sh <test-type> [environment]"
  echo "Test types: smoke, load, stress, spike, soak"
  exit 1
fi

if [ -z "$ENV" ]; then
  ENV="development"
fi

echo "🚀 Starting $TYPE test against $ENV environment..."

APP_ENV=$ENV k6 run --insecure-skip-tls-verify scenarios/$TYPE.js

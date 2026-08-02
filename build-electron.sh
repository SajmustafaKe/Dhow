#!/bin/bash
set -e

# build dhowx next.js app
(cd apps/dhowx && \
    npm install && \
    npm run build)

# build dhow server
(cd apps/cli && \
    npm install && \
    npm run build)
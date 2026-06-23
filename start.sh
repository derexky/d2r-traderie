#!/bin/bash
set -e

Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
export DISPLAY=:99

exec node dist/src/main

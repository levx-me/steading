# Sourced (POSIX sh): sets $py to the Python every Steading script runs on: $STEADING_PYTHON if
# set, else the newest the user installed (Homebrew, then /usr/local), else the system python3.
py=python3
for p in "${STEADING_PYTHON:-}" /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  [ -n "$p" ] && [ -x "$p" ] && { py=$p; break; }
done

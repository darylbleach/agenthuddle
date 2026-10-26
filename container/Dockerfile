FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    ca-certificates curl git gh openssh-client python3 ripgrep jq procps util-linux less unzip \
    dbus dbus-x11 gnome-keyring libsecret-tools \
 && rm -rf /var/lib/apt/lists/*

# Official agent CLIs
RUN npm install -g @anthropic-ai/claude-code @openai/codex \
 && npm cache clean --force

RUN useradd -m -s /bin/bash agent
USER agent
ENV HOME=/home/agent PATH=/home/agent/.local/bin:/home/agent/.grok/bin:/home/agent/.antigravity/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /home/agent

# Official installers for Cursor Agent, Google Antigravity (agy) and xAI Grok (grok).
# Each is allowed to fail so one changed installer doesn't break the whole image.
RUN (curl -fsS https://cursor.com/install | bash) || echo "WARNING: cursor-agent install failed"
RUN (curl -fsSL https://antigravity.google/cli/install.sh | bash) || echo "WARNING: agy install failed"
RUN (curl -fsSL https://x.ai/cli/install.sh | bash) || echo "WARNING: grok install failed"
# Installers sometimes put binaries in their own folders; link them onto PATH.
RUN mkdir -p /home/agent/.local/bin && for b in agy grok cursor-agent; do \
      command -v $b >/dev/null 2>&1 && continue; \
      f=$(find /home/agent -maxdepth 5 \( -type f -o -type l \) -name "$b" 2>/dev/null | head -1); \
      [ -n "$f" ] && ln -sf "$f" /home/agent/.local/bin/$b; \
    done; ls -la /home/agent/.local/bin || true

# Isolation: the runner runs as root; each agent CLI runs as its own user with a private home,
# git as ar-git, the console shell as ar-shell (see users.mjs). The CLIs installed above under
# /home/agent are made readable and runnable by those users; no logins are kept in /home/agent.
USER root
ENV HOME=/root PATH=/home/agent/.local/bin:/home/agent/.grok/bin:/home/agent/.antigravity/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN chmod -R a+rX /home/agent \
 && for u in ar-claude ar-codex ar-agy ar-cursor ar-grok ar-git ar-shell; do /usr/sbin/useradd -m -U -s /bin/bash "$u"; chmod 700 "/home/$u"; done \
 && git config --system --add safe.directory '*' \
 && mkdir -p /work /opt/agenthuddle && chmod 711 /work
COPY runner.mjs usage.mjs keyring.mjs users.mjs approve-mcp.mjs codex-app.mjs /opt/agenthuddle/
EXPOSE 8080
CMD ["node", "/opt/agenthuddle/runner.mjs"]

# OMA Default Sandbox Base Image — Sandbox SDK 1.0
# Base: Debian + toolchain. Copy sandbox-shim from cloudflare/sandbox:1.0.3
# (must match @cloudflare/sandbox in package.json). Files / S3Mount /
# DirectoryBackup require the shim. FUSE/s3fs required for bucket mounts.
# sandbox-shim passes `-o compat_dir` to s3fs, which needs s3fs >= 1.92:
# bookworm ships 1.90 ("unknown option 'compat_dir'"), trixie ships 1.95.

FROM docker.io/node:24-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git jq \
    build-essential make cmake \
    vim nano tmux \
    tree htop less file \
    zip unzip \
    sqlite3 \
    sudo \
    fuse3 s3fs \
    squashfs-tools \
    && rm -rf /var/lib/apt/lists/*

# sandbox-shim for @cloudflare/sandbox 1.0 Files / S3Mount / DirectoryBackup
COPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

# GitHub CLI
RUN curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 \
      https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# ripgrep
RUN ARCH=$(dpkg --print-architecture) && \
    RG_VERSION="14.1.1" && \
    if [ "$ARCH" = "amd64" ]; then RG_ARCH="x86_64"; else RG_ARCH="aarch64"; fi && \
    curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 \
      "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-${RG_ARCH}-unknown-linux-musl.tar.gz" \
    | tar xz --strip-components=1 -C /usr/local/bin "ripgrep-${RG_VERSION}-${RG_ARCH}-unknown-linux-musl/rg"

# uv + Python 3.12
RUN curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 \
      https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"
RUN uv python install 3.12 && \
    uv venv /opt/venv --python 3.12 --seed
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

RUN uv pip install --no-cache \
    requests httpx pyyaml toml \
    pandas numpy \
    pytest black ruff mypy

# Go 1.22
RUN curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 \
      "https://go.dev/dl/go1.22.5.linux-$(dpkg --print-architecture).tar.gz" \
    | tar -xz -C /usr/local
ENV PATH="/usr/local/go/bin:/root/go/bin:${PATH}"

# Rust (minimal)
RUN curl --proto '=https' --tlsv1.2 -sSf --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 \
      https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /workspace
CMD ["sleep", "infinity"]

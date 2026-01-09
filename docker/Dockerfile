# Lightweight sandbox for yep-anywhere + Claude
# Build: docker build -t yep-sandbox docker/
# Run: docker compose -f docker/docker-compose.yml up

FROM node:22-slim

# Install essentials
RUN apt-get update && apt-get install -y \
    git \
    curl \
    openssh-client \
    procps \
    net-tools \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install Claude CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user (UID/GID passed at build time)
# Default to 1000:1000 - the node image already has group 1000, so use --non-unique
ARG USER_UID=1000
ARG USER_GID=1000

RUN groupadd --gid $USER_GID --non-unique sandbox \
    && useradd --uid $USER_UID --gid $USER_GID --non-unique -m sandbox

# Switch to non-root user
USER sandbox
WORKDIR /home/sandbox

# Default command - can be overridden
CMD ["bash"]

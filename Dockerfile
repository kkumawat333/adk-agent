# Container image for the AgentCore Runtime (BYO TypeScript agent).
# Mirrors the AgentCore CLI's own TypeScript container template, but runs our
# ADK entrypoint (agentcore_runtime.ts) which wraps the `bug_fixer` agent.
#
# AgentCore builds this on ARM64 in CodeBuild. The build context is the project
# root (see .dockerignore) because bug_agent.ts imports sibling modules
# (bedrock_llm.ts, skill_toolset.ts) and reads the bug_skills/ directory.
FROM public.ecr.aws/docker/library/node:22-slim

WORKDIR /app

ENV NODE_ENV=production \
    DOCKER_CONTAINER=1

# Run as a non-root user (matches the AgentCore runtime template).
RUN userdel -r node 2>/dev/null || true
RUN useradd -m -u 1000 bedrock_agentcore

# Install dependencies first for better layer caching. tsx and bedrock-agentcore
# are regular dependencies, so --omit=dev keeps them.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY --chown=bedrock_agentcore:bedrock_agentcore . .

USER bedrock_agentcore

# AgentCore Runtime service contract ports
# https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html
# 8080: HTTP Mode  |  8000: MCP Mode  |  9000: A2A Mode
EXPOSE 8080 8000 9000

# tsx runs the TypeScript entrypoint directly (no separate build step).
CMD ["npx", "tsx", "agentcore_runtime.ts"]

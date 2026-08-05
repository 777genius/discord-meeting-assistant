# syntax=docker/dockerfile:1.7

FROM python:3.13.14-slim-bookworm@sha256:9d7f287598e1a5a978c015ee176d8216435aaf335ed69ac3c38dd1bbb10e8d64 AS build

COPY --from=ghcr.io/astral-sh/uv:0.11.12@sha256:3a59a3cdd5f7c217faa36e32dbc7fddbb0412889c2a0a5229f6d790e5a019dd7 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_DEV=1

WORKDIR /build

COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project

COPY src ./src
RUN uv sync --frozen --no-dev --no-editable


FROM python:3.13.14-slim-bookworm@sha256:9d7f287598e1a5a978c015ee176d8216435aaf335ed69ac3c38dd1bbb10e8d64 AS runtime

RUN groupadd --system --gid 10001 pipecat \
    && useradd --system --uid 10001 --gid pipecat --home-dir /nonexistent --shell /usr/sbin/nologin pipecat

WORKDIR /app

ENV HOME=/tmp \
    PATH="/app/.venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TMPDIR=/tmp \
    XDG_CACHE_HOME=/tmp

COPY --from=build --chown=10001:10001 /build/.venv /app/.venv

USER 10001:10001

ENTRYPOINT ["python", "-c", "from pipecat_runtime.entrypoint import main; main()"]

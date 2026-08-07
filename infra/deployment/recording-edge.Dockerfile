FROM caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648

RUN cp /usr/bin/caddy /usr/local/bin/caddy-unprivileged \
  && chown 10001:10001 /usr/local/bin/caddy-unprivileged

USER 10001:10001
ENTRYPOINT ["/usr/local/bin/caddy-unprivileged"]

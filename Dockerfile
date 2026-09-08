# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@12.3.4 --activate

WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @moneykernel/kernel deploy --prod /opt/moneykernel/apps/kernel
RUN mkdir -p /opt/moneykernel/apps/web /opt/moneykernel/fixtures \
    && cp -R apps/web/dist /opt/moneykernel/apps/web/dist \
    && cp -R fixtures/scenarios /opt/moneykernel/fixtures/scenarios \
    && mkdir -p /var/lib/moneykernel \
    && chown -R 65532:65532 /opt/moneykernel /var/lib/moneykernel

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:774b7d020b24214835769e24c3544835526cd0288f0b094eae48e8b2c2429a79 AS runtime

ENV NODE_ENV=production
WORKDIR /opt/moneykernel/apps/kernel
COPY --from=build --chown=65532:65532 /opt/moneykernel /opt/moneykernel
COPY --from=build --chown=65532:65532 /var/lib/moneykernel /var/lib/moneykernel

LABEL org.opencontainers.image.source="https://github.com/Vasanthdev2004/moneykernel"
USER 65532:65532
EXPOSE 8080
CMD ["--import", "tsx", "src/server.ts"]

FROM dart:stable

ENV PATH="/root/.pub-cache/bin:${PATH}"
ENV PORT=8080
ENV FFAI_WORKSPACE=/workspace/custom_code_connect

ARG FLUTTERFLOW_CLI_VERSION=0.0.39
RUN dart pub global activate flutterflow_cli "$FLUTTERFLOW_CLI_VERSION" \
    && dart pub global list | grep -F "flutterflow_cli $FLUTTERFLOW_CLI_VERSION"

# Generated custom classes import package:flutter, so compiling them before a
# deploy needs the Flutter SDK, not just Dart. Without it `flutter analyze`
# cannot run at all and every deploy would report itself unverified.
ARG FLUTTER_CHANNEL=stable
RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$FLUTTER_CHANNEL" \
        https://github.com/flutter/flutter.git /opt/flutter \
    && git config --global --add safe.directory /opt/flutter
ENV PATH="/opt/flutter/bin:${PATH}"
# `flutter --version` triggers the first-run download of the SDK's Dart
# toolchain, so the image ships with it rather than fetching it on the first
# deploy to hit a cold instance. Engine artifacts are deliberately NOT
# precached: `flutter pub get` + `flutter analyze` never use them, and pulling
# every platform's build would add gigabytes and risk Cloud Build's timeout.
RUN flutter --version

WORKDIR /app
COPY pubspec.yaml ./
RUN dart pub get

RUN mkdir -p /workspace

COPY bin/ ./bin/

EXPOSE 8080

CMD ["dart", "run", "bin/server.dart"]

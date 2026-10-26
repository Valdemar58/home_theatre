# ИИ-апскейл картинок для календаря: Real-ESRGAN (ncnn + Vulkan) за маленьким HTTP-сервером.
# GPU NVIDIA — через compose.nvidia.yml (Vulkan-драйвер прокидывает nvidia-container-toolkit),
# без GPU работает на CPU (lavapipe) — медленно, но работает.
FROM debian:bookworm-slim

ARG REALESRGAN_URL=https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip python3 libvulkan1 mesa-vulkan-drivers libgomp1 \
    # Vulkan-драйверу NVIDIA (libGLX_nvidia) нужны X-библиотеки и glvnd, даже без экрана
    libxext6 libx11-6 libglvnd0 libglx0 libegl1 \
 && curl -fsSL -o /tmp/r.zip "$REALESRGAN_URL" \
 && mkdir -p /opt/realesrgan && unzip -q /tmp/r.zip -d /opt/realesrgan && rm /tmp/r.zip \
 && chmod +x /opt/realesrgan/realesrgan-ncnn-vulkan \
 && apt-get purge -y unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Vulkan-драйвер NVIDIA (иначе — lavapipe на CPU)
ENV NVIDIA_DRIVER_CAPABILITIES=all
COPY server.py /opt/server.py
EXPOSE 8000
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s CMD curl -fs http://127.0.0.1:8000/health || exit 1
CMD ["python3", "-u", "/opt/server.py"]

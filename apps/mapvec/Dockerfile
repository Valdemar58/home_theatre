# Векторизация карт мира для календаря: подписи читает dots.mocr (OCR с рамками строк), сушу и страны выделяет SAM 2.
# GPU NVIDIA — через compose.nvidia.yml; без GPU работает на CPU (подписи — минуты вместо полутора).
FROM python:3.11-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 curl \
 && rm -rf /var/lib/apt/lists/*

# torch с CUDA 12.8. Библиотеки NVIDIA лежат на pypi.nvidia.com, а он отдаёт ~300 КБ/с на соединение:
# если колёса скачаны заранее в wheels/ (параллельно), ставим из них, иначе — из индекса PyTorch
RUN --mount=type=bind,source=wheels,target=/wheels \
    if ls /wheels/*.whl >/dev/null 2>&1; then pip install --no-cache-dir /wheels/*.whl; \
    else pip install --no-cache-dir torch==2.9.1 torchvision==0.24.1 --index-url https://download.pytorch.org/whl/cu128; fi
RUN pip install --no-cache-dir transformers==4.57.6 accelerate qwen_vl_utils huggingface_hub pillow \
    opencv-python-headless scikit-image ultralytics

# Веса (dots.mocr ~6 ГБ, SAM 2.1) качаются при первом запросе в /models — том в config
ENV HF_HOME=/models/hf YOLO_CONFIG_DIR=/models/ultralytics
WORKDIR /opt/mapvec
COPY *.py ./
EXPOSE 8000
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s CMD curl -fs http://127.0.0.1:8000/health || exit 1
CMD ["python3", "-u", "server.py"]

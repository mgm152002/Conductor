FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    MEM0_TELEMETRY=false ANONYMIZED_TELEMETRY=false \
    FASTEMBED_CACHE_PATH=/data/models HF_HOME=/data/huggingface \
    MEM0_DIR=/data/mem0 OMP_NUM_THREADS=2 TOKENIZERS_PARALLELISM=false
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY no_inference.py server.py ./
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log"]

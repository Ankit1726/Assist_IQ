FROM python:3.11-slim

WORKDIR /agent

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=8080
ENV FASTEMBED_CACHE_PATH=/opt/fastembed

COPY requirements.txt .

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
    && pip install --no-cache-dir -r requirements.txt \
    && python -c "from fastembed import TextEmbedding; model = TextEmbedding(model_name='sentence-transformers/all-MiniLM-L6-v2', cache_dir='/opt/fastembed', threads=1); next(model.embed(['warm up embedding model']))"

COPY . .

EXPOSE 8080

CMD ["sh", "-c", "uvicorn agent.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
# ---------- Base Image ----------
FROM python:3.11-slim AS base

WORKDIR /app

# ---------- System dependencies ----------
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# ---------- Python dependencies ----------
COPY ./requirements.txt /app/requirements.txt

# Use pip cache mount to speed up rebuilds
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r /app/requirements.txt

# ---------- Copy application ----------
COPY . /app

# ---------- Command ----------
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

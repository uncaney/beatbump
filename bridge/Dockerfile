FROM python:3.12-slim
RUN pip install --no-cache-dir "aiohttp==3.10.11" "mutagen==1.47.0"
COPY bridge.py /app/bridge.py
WORKDIR /app
USER 1000:1000
CMD ["python", "bridge.py"]

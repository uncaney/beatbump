FROM python:3.12-slim
RUN pip install --no-cache-dir "mutagen==1.47.0"
COPY indexer.py /app/indexer.py
WORKDIR /app
USER 1000:1000
CMD ["python", "-u", "indexer.py"]

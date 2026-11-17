FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/home/learner \
    USER=learner \
    PATH=/usr/local/bin:/usr/bin:/bin \
    LANG=C.UTF-8

RUN useradd --uid 1000 --create-home --home-dir /home/learner --shell /bin/sh learner

COPY runner.py /runner.py

USER 1000:1000
WORKDIR /home/learner
ENTRYPOINT ["python", "/runner.py"]

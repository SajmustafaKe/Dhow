FROM python:3.12

WORKDIR /app

COPY requirements.txt .

RUN pip install -r requirements.txt

COPY . .

CMD ["mkdocs", "serve", "--dev-addr", "0.0.0.0:8000"]
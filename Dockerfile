# Satu image untuk aplikasi + ekspor dokumen (Node + Python).
# Ekspor PPTX/DOCX/IDML/XLSX memanggil export_bridge.py lewat child process,
# jadi runtime Python harus ada di image yang sama -- tidak perlu sidecar.
FROM node:22-bookworm-slim

ENV PORT=8080 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/py
ENV PATH="/opt/py/bin:$PATH"

WORKDIR /app/node-app

# Dependensi dulu supaya layer cache tidak batal tiap kali kode berubah.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY --chown=node:node . .

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

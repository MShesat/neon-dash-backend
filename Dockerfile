FROM node:20-bullseye-slim

# Instalar dependencias del sistema: Python3, FFmpeg, curl, certificados
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Instalar binario oficial y actualizado de yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Configurar usuario estándar para compatibilidad con Hugging Face Spaces (UID 1000)
RUN useradd -m -u 1000 user
WORKDIR /app

# Copiar dependencias y compilar
COPY --chown=user:user package.json ./
RUN npm install --production

# Copiar el código fuente y cookies
COPY --chown=user:user . .

# Asignar usuario sin privilegios de root
USER user

# Puerto estándar de Hugging Face Spaces y contenedores cloud
ENV PORT=7860
EXPOSE 7860

CMD ["node", "server.js"]

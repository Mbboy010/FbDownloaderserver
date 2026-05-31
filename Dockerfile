# Using the slim version significantly reduces the base image size
FROM node:20-slim

# Install dependencies and clear the apt cache to keep the image small
RUN apt-get update && \
    apt-get install -y ffmpeg python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*

# Install yt-dlp. The --break-system-packages flag is required on modern 
# Debian/Ubuntu systems to bypass the "externally managed environment" error.
RUN pip3 install --break-system-packages yt-dlp

WORKDIR /app

# Copy package files first to leverage Docker layer caching
COPY package*.json ./
RUN npm install

# Copy the rest of your application code
COPY . .

CMD ["node", "index.js"]

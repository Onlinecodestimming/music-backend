FROM node:18

# Install Python + pip
RUN apt-get update && apt-get install -y python3 python3-pip

# Install yt-dlp globally
RUN pip install yt-dlp

# Create app directory
WORKDIR /app

# Copy project files
COPY . .

# Install node dependencies
RUN npm install

# Expose port
EXPOSE 8080

# Start backend
CMD ["node", "index.js"]

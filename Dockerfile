# Use Node official image
FROM node:18

# Create app directory inside container
WORKDIR /app

# Copy package files first
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy everything else
COPY . .

# Expose your Node app port (change if needed)
EXPOSE 3000

# Start the app
CMD ["node", "index.js"]

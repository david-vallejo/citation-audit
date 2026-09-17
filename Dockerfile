FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY schema.sql ./
COPY src ./src
ENV PORT=8322
EXPOSE 8322
CMD ["node", "src/server.js"]

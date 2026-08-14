FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

COPY watcher/package*.json ./watcher/

RUN cd watcher && npm install

COPY watcher ./watcher

WORKDIR /app/watcher

EXPOSE 3000

CMD ["npm", "start"]
